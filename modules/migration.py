"""Phase B+ migration support — archive site content + cache CF record IDs
and Origin CA certs so a dead-server migration can move a domain to a new
droplet in ~60s instead of re-running the full 10-step pipeline.

The migrator itself (migrate_domain) is Phase 2 work — this module handles
Phase 1: capture + cleanup only. When Phase 2 lands, wrap migrate_domain's
body in `modules.pipeline.HeartbeatTicker(domain, 1.0)` so the watcher UI
can prove the migrator is still alive during slow steps (SA app create +
SSL install each take 15–30s).

Archive layout:
    data/site_archives/{domain}.tar.gz
        ├─ index.php        (Gemini-generated PHP, what step 10 uploads)
        └─ metadata.json    (niche, generated_at, size, sha256)

Archives are ~5–10 KB each (gzip on single-page HTML compresses well).
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import tarfile
from datetime import datetime, timezone

import requests

from database import (
    get_db, get_domain, get_domains, get_servers,
    log_pipeline, update_domain,
)
from modules.cloudflare_api import _get_zone_id, _headers_for_domain, CF_API

ARCHIVE_DIR = os.path.join("data", "site_archives")

# Strict whitelist — only lowercase letters, digits, hyphens, and dots.
# Any input outside this shape CANNOT produce a path-traversal archive name.
_DOMAIN_PATH_RE = __import__("re").compile(r"^[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)+$")


def _archive_path(domain: str) -> str:
    """Construct the local archive path for a domain.

    Defensive: validates the domain against a strict regex so a corrupt DB
    row (or a future call site that forgot to sanitize) cannot escape
    ARCHIVE_DIR via `../` segments or OS-specific separators.
    """
    d = (domain or "").strip().lower()
    if not d or len(d) > 253 or not _DOMAIN_PATH_RE.match(d):
        raise ValueError(f"refuse to build archive path for invalid domain: {domain!r}")
    return os.path.join(ARCHIVE_DIR, f"{d}.tar.gz")


def archive_site(domain: str, php_content: str, metadata: dict | None = None) -> str:
    """Gzip-tar the generated site content and save under data/site_archives/.

    Returns the archive path. Updates domains.content_archive_path.
    Idempotent — overwrites any existing archive for the same domain.
    """
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    php_bytes = php_content.encode("utf-8")

    meta = {
        "domain": domain,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bytes": len(php_bytes),
        "sha256": hashlib.sha256(php_bytes).hexdigest(),
    }
    if metadata:
        meta.update(metadata)
    meta_bytes = json.dumps(meta, indent=2).encode("utf-8")

    path = _archive_path(domain)
    with tarfile.open(path, "w:gz") as tar:
        info = tarfile.TarInfo(name="index.php")
        info.size = len(php_bytes)
        info.mtime = int(datetime.now(timezone.utc).timestamp())
        tar.addfile(info, io.BytesIO(php_bytes))

        mi = tarfile.TarInfo(name="metadata.json")
        mi.size = len(meta_bytes)
        mi.mtime = int(datetime.now(timezone.utc).timestamp())
        tar.addfile(mi, io.BytesIO(meta_bytes))

    update_domain(domain, content_archive_path=path)
    log_pipeline(domain, "archive", "completed",
                 f"Site archived ({os.path.getsize(path)} bytes → {path})")
    return path


def read_archive(domain: str) -> tuple[str, dict] | None:
    """Return (php_content, metadata) for a domain's archive, or None."""
    d = get_domain(domain)
    path = (d and d["content_archive_path"]) or _archive_path(domain)
    if not os.path.exists(path):
        return None
    with tarfile.open(path, "r:gz") as tar:
        php = tar.extractfile("index.php").read().decode("utf-8")
        try:
            meta = json.loads(tar.extractfile("metadata.json").read().decode("utf-8"))
        except (KeyError, json.JSONDecodeError):
            meta = {}
    return php, meta


def delete_archive(domain: str) -> bool:
    """Remove a domain's archive from disk. Safe to call when no archive exists."""
    path = _archive_path(domain)
    if os.path.exists(path):
        try:
            os.remove(path)
            log_pipeline(domain, "archive", "completed", f"Archive removed: {path}")
            return True
        except OSError as e:
            log_pipeline(domain, "archive", "warning", f"Archive delete failed: {e}")
            return False
    return False


def capture_cf_record_ids(domain: str) -> dict:
    """Fetch apex + www A-record IDs from Cloudflare and cache in DB.

    Migration will PATCH these record IDs directly instead of list+search,
    shaving ~2s off each migration. Returns {"a": id, "www": id}.
    """
    d = get_domain(domain)
    if not d or not d["cf_zone_id"]:
        raise RuntimeError(f"{domain}: no cf_zone_id in DB — zone not created yet?")

    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    captured = {"a": None, "www": None}

    for name, key in ((domain, "a"), (f"www.{domain}", "www")):
        r = requests.get(
            f"{CF_API}/zones/{zone_id}/dns_records",
            params={"type": "A", "name": name}, headers=headers, timeout=30,
        )
        r.raise_for_status()
        results = r.json().get("result") or []
        if results:
            captured[key] = results[0]["id"]

    update_domain(
        domain,
        cf_a_record_id=captured["a"],
        cf_www_record_id=captured["www"],
    )
    log_pipeline(domain, "cf_record_capture", "completed",
                 f"Cached A-record IDs: apex={captured['a']} www={captured['www']}")
    return captured


def save_origin_cert(domain: str, cert_pem: str, key_pem: str) -> None:
    """Cache the CF Origin CA cert + private key in DB so migrations can
    reinstall the same cert without asking CF to re-issue (saves ~30s and
    keeps the same 15-year validity).

    The key lives in the SQLite file alongside CF/SA API keys — no new
    secret-storage surface area.
    """
    update_domain(domain, origin_cert_pem=cert_pem, origin_key_pem=key_pem)
    log_pipeline(domain, "origin_cert_cache", "completed",
                 f"Cached Origin CA cert ({len(cert_pem)}B) + key ({len(key_pem)}B)")


def patch_cf_a_records(domain: str, new_ip: str) -> dict:
    """Fast-path for migration step: PATCH apex + www A records to new_ip
    using the cached record IDs. Falls back to list+search if IDs missing.

    Returns {"a": bool, "www": bool} indicating success per record.
    """
    d = get_domain(domain)
    if not d:
        raise RuntimeError(f"{domain}: no DB row")

    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    result = {"a": False, "www": False}

    for rec_col, name, key in (
        ("cf_a_record_id", domain, "a"),
        ("cf_www_record_id", f"www.{domain}", "www"),
    ):
        rec_id = d[rec_col]
        if not rec_id:
            # fallback: list+search (same cost as pre-Phase-1 path)
            r = requests.get(
                f"{CF_API}/zones/{zone_id}/dns_records",
                params={"type": "A", "name": name}, headers=headers, timeout=30,
            )
            if r.ok and (r.json().get("result") or []):
                rec_id = r.json()["result"][0]["id"]
        if not rec_id:
            log_pipeline(domain, "migrate_dns", "warning",
                         f"No {name} A record to patch")
            continue

        pr = requests.patch(
            f"{CF_API}/zones/{zone_id}/dns_records/{rec_id}",
            json={"content": new_ip}, headers=headers, timeout=30,
        )
        result[key] = pr.ok and pr.json().get("success", False)

    log_pipeline(domain, "migrate_dns", "completed" if all(result.values()) else "warning",
                 f"CF A-records → {new_ip}  apex={result['a']} www={result['www']}")
    return result


# ---------------------------------------------------------------------------
# Phase 2: migrate_domain / migrate_server
# ---------------------------------------------------------------------------

def migrate_domain(domain: str, new_server: dict) -> tuple[bool, str]:
    """Move `domain` from its current server to `new_server`. Returns (ok, msg).

    Uses cached CF records + cached Origin cert + local archive. If any of
    those are missing, falls back to the slower re-issue / list+search paths
    so Phase-1-pre-existing domains still migrate — just slower.

    Steps (all within a HeartbeatTicker so the watcher shows it's alive):
      1. Create the SA app on the new server.
      2. Install SSL using cached Origin cert (or re-issue from CF).
      3. Upload content from the local archive (fallback: domains.site_html).
      4. PATCH the CF apex + www A-records to the new server IP.
      5. Update domains.server_id, current_proxy_ip, status.
      6. Adjust both servers' sites_count.
      7. Best-effort delete of the SA app on the OLD server (may fail if the
         old server is actually dead — that's fine, the droplet will be
         garbage-collected later).
    """
    # Import here so module can load without pipeline (avoids circular imports
    # during app.py startup when migration is imported very early).
    from modules.pipeline import (
        HeartbeatTicker, _try_acquire_slot, _release_slot,
    )
    from modules import serveravatar, cloudflare_api

    d = get_domain(domain)
    if not d:
        return False, f"{domain}: no DB row"
    if not d["cf_zone_id"]:
        return False, f"{domain}: no CF zone — cannot migrate"
    if not new_server or not new_server.get("sa_server_id"):
        return False, f"{domain}: new_server has no sa_server_id"

    # R3/R6: acquire the same per-domain slot the pipeline uses, so a migration
    # can't collide with a manual pipeline run OR a teardown of the same
    # domain. Skip cleanly if someone else is already mutating the domain.
    if not _try_acquire_slot(domain):
        return False, (f"{domain}: another worker (pipeline/teardown/migration) "
                       "is already running for this domain — skipped")

    old_server_id = d["server_id"]
    new_server_id = new_server["id"]
    new_sa_id = new_server["sa_server_id"]
    new_ip = new_server["ip"]

    log_pipeline(domain, "migrate", "running",
                 f"Starting migration → server #{new_server_id} ({new_ip})")

    try:
        with HeartbeatTicker(domain, interval=1.0):
            # ----- 1. Create SA app on new server -----
            try:
                app_id = serveravatar.create_application(new_sa_id, domain)
            except Exception as e:
                # If the app already exists (e.g., migration was half-done
                # earlier) look it up instead of failing.
                app_id = serveravatar._find_app_id(new_sa_id, domain)
                if not app_id:
                    log_pipeline(domain, "migrate", "failed",
                                 f"SA create_application: {e}")
                    return False, f"SA app create failed: {e}"
                log_pipeline(domain, "migrate", "running",
                             f"SA app already existed (id={app_id}) — reusing")

            # ----- 2. Install SSL (prefer cached cert, else re-issue) -----
            cert_pem = d["origin_cert_pem"]
            key_pem = d["origin_key_pem"]
            if not cert_pem or not key_pem:
                log_pipeline(domain, "migrate", "running",
                             "No cached Origin cert — re-issuing from Cloudflare...")
                try:
                    bundle = cloudflare_api.fetch_origin_ca_cert(domain)
                    cert_pem = bundle["certificate"]
                    key_pem = bundle["private_key"]
                    save_origin_cert(domain, cert_pem, key_pem)
                except Exception as e:
                    log_pipeline(domain, "migrate", "failed",
                                 f"Origin cert fetch: {e}")
                    return False, f"cert fetch failed: {e}"

            # Briefly grey-cloud so the install flow sees the origin directly
            try:
                cloudflare_api.set_dns_a_record(domain, new_ip, proxied=False)
                cloudflare_api.set_dns_a_record_www(domain, new_ip, proxied=False)
            except Exception as e:
                log_pipeline(domain, "migrate", "warning",
                             f"grey-cloud pre-install: {e}")

            install_ok, install_msg = False, ""
            try:
                install_ok, install_msg = serveravatar.install_custom_ssl(
                    new_sa_id, app_id, cert_pem, key_pem, "",
                    force_https=True, domain=domain, server_ip=new_ip,
                )
            except Exception as e:
                install_msg = f"install error: {e}"
            finally:
                # Restore orange cloud + update DB to point to new IP.
                try:
                    cloudflare_api.set_dns_a_record(domain, new_ip, proxied=True)
                    cloudflare_api.set_dns_a_record_www(domain, new_ip, proxied=True)
                except Exception as e:
                    log_pipeline(domain, "migrate", "warning",
                                 f"orange-cloud restore: {e}")

            if not install_ok:
                log_pipeline(domain, "migrate", "failed",
                             f"SSL install: {install_msg}")
                return False, f"SSL install failed: {install_msg}"

            # ----- 3. Upload content from archive (or DB fallback) -----
            php = None
            try:
                archived = read_archive(domain)
                if archived:
                    php = archived[0]
            except Exception as e:
                log_pipeline(domain, "migrate", "warning",
                             f"archive read: {e}  — will try DB fallback")
            if not php:
                php = d["site_html"]
            if not php or len(php) < 50:
                log_pipeline(domain, "migrate", "failed",
                             "No archive AND no site_html in DB — cannot migrate content")
                return False, "no archived content to upload"

            try:
                serveravatar.upload_index_php(new_sa_id, domain, php)
            except Exception as e:
                log_pipeline(domain, "migrate", "failed", f"upload_index_php: {e}")
                return False, f"content upload failed: {e}"

            # ----- 4. PATCH CF A-records to new IP (fast-path via cached IDs) -----
            try:
                patch_cf_a_records(domain, new_ip)
            except Exception as e:
                log_pipeline(domain, "migrate", "warning",
                             f"CF record patch: {e}  — DNS may be stale")

            # Re-capture in case records were recreated (e.g., from fallback path)
            try:
                capture_cf_record_ids(domain)
            except Exception:
                pass

            # ----- 5. Update domain row (sites_count is computed on read) ---
            update_domain(
                domain,
                server_id=new_server_id,
                current_proxy_ip=new_ip,
                status="hosted",
            )

            # ----- 6. Best-effort delete on the OLD server (skip if dead) ---
            if old_server_id and old_server_id != new_server_id:
                old = next((dict(s) for s in get_servers()
                            if s["id"] == old_server_id), None)
                if old and old.get("sa_server_id"):
                    try:
                        serveravatar.delete_application(old["sa_server_id"], domain)
                        log_pipeline(domain, "migrate", "running",
                                     f"Deleted app from old server #{old_server_id}")
                    except Exception as e:
                        log_pipeline(domain, "migrate", "warning",
                                     f"Old-server cleanup failed (expected if "
                                     f"that server is dead): {e}")

            log_pipeline(domain, "migrate", "completed",
                         f"Migrated to server #{new_server_id} ({new_ip})")
            return True, f"migrated to #{new_server_id} ({new_ip})"
    finally:
        _release_slot(domain)


def migrate_server(old_server_id: int, new_server_id: int | None = None) -> dict:
    """Migrate every domain hosted on old_server_id to a new server.

    If new_server_id is given, use that server. Otherwise find any ready
    server with capacity for the whole batch — falls back to provisioning
    a fresh droplet via the step-6 logic.

    Returns {"ok": [domain, ...], "failed": [(domain, reason), ...],
             "new_server_id": int}. Fire-and-forget; call from a thread.

    Heartbeat: every migrated domain gets its last_heartbeat_at pulsed
    every second across the WHOLE migration (not just its own migrate_domain
    window) so the watcher UI stays green during the 5–15 min target-server
    provisioning phase that blocks all domains at once.
    """
    from modules.pipeline import (
        HeartbeatTicker, _find_server, _step6_get_or_provision_server,
    )

    old_rows = [d for d in get_domains() if d["server_id"] == old_server_id]
    if not old_rows:
        return {"ok": [], "failed": [], "new_server_id": None,
                "msg": f"No domains on server #{old_server_id} — nothing to do"}

    domains = [r["domain"] for r in old_rows]
    with HeartbeatTicker(domains, interval=1.0):
        # Pick / provision a destination server.
        if new_server_id:
            target = next((dict(s) for s in get_servers()
                           if s["id"] == int(new_server_id)), None)
        else:
            target = _find_server(explicit_id=None)
            # If the only "ready" server is the dead one, _find_server may
            # return it — filter and provision a fresh droplet if needed.
            if target and target["id"] == old_server_id:
                target = None
        if not target:
            # Provision a new droplet. We hand the FIRST domain to step 6 as
            # the log target so the user sees progress on a real row; the
            # droplet itself serves all migrated domains.
            anchor = old_rows[0]["domain"]
            target = _step6_get_or_provision_server(anchor)
        if not target:
            return {"ok": [],
                    "failed": [(r["domain"], "no target server") for r in old_rows],
                    "new_server_id": None,
                    "msg": "Could not get/provision a target server"}

        ok, failed = [], []
        for row in old_rows:
            domain = row["domain"]
            try:
                # migrate_domain spawns its own per-domain HeartbeatTicker —
                # that's fine, the two tickers just both pulse the same row.
                success, msg = migrate_domain(domain, target)
                (ok if success else failed).append(
                    domain if success else (domain, msg))
            except Exception as e:
                failed.append((domain, f"unhandled: {e}"))

        return {
            "ok": ok, "failed": failed,
            "new_server_id": target["id"],
            "msg": f"Migrated {len(ok)}/{len(old_rows)} domains "
                   f"from #{old_server_id} → #{target['id']}",
        }
