"""Pipeline Orchestrator v2 — runs the full automation flow for a domain.

SMART RESUME: detects what's already done and picks up from there.
WATCHER: emits step-by-step events so the dashboard can show live progress.
SEQUENTIAL: each step must complete before the next runs.

Ten steps:
  1. Buy / Detect Domain            — Spaceship availability check + purchase OR
                                      detect bring-your-own. If not in our account
                                      and not available, pause for manual NS change.
  2. Assign Cloudflare Key          — cf_key_pool picks the next CF account with
                                      capacity (20/key). Populates cf_email,
                                      cf_global_key, cf_account_id on the domain.
  3. Create Zone in Cloudflare      — POST /zones; stores cf_zone_id + CF nameservers.
  4. Set Nameservers                — Spaceship set_nameservers (our account)
                                      OR log manual instructions (external registrar).
  5. Wait for Zone Active           — Poll CF zone status up to 10 min.
  6. Pick / Provision Server        — Use server with sites_count < max_sites (60),
                                      else spin up a new DO droplet + install SA agent.
  7. Create Site on ServerAvatar    — create_application + A record to server IP
                                      (proxied/orange cloud, SSL full).
  8. Issue & Install Origin SSL     — fetch_origin_ca_cert (15y) + install_custom_ssl
                                      with CF's Origin CA root as chain.
  9. Generate Site Content (LLM)    — single-call Haiku 4.5 with content blocklist.
                                      Raises ContentBlockedError for prohibited niches.
 10. Upload index.php               — write LLM output as index.php to SA app public folder.

Domain row statuses (non-exhaustive):
  pending, purchased, owned (BYO), cf_assigned, zone_created, ns_set,
  zone_active, app_created, ssl_installed, live,
  error, content_blocked, cf_pool_full, ns_pending_external
"""

import time
import threading
import random

from database import (
    add_domain, update_domain, get_domain, get_servers, get_db,
    log_pipeline, get_setting, init_steps, update_step,
    heartbeat,
)
from modules import spaceship, cloudflare_api, serveravatar, website_generator, digitalocean
from modules.cf_key_pool import (
    assign_cf_key_to_domain, CFKeyPoolExhausted,
)
from modules.website_generator import ContentBlockedError

# ---------------------------------------------------------------------------
# Public entry points (unchanged from v1)
# ---------------------------------------------------------------------------

# --------- Per-domain pipeline lock (F1) ---------
# Guards against two concurrent pipeline workers running on the same domain
# (user double-click, bulk+single overlap, auto-migrate colliding with a
# manual run, etc). In-memory set + lock is sufficient since pipelines only
# run within one process.
_inflight_domains: set[str] = set()
_inflight_lock = threading.Lock()


def is_pipeline_running(domain: str) -> bool:
    with _inflight_lock:
        return domain in _inflight_domains


def _try_acquire_slot(domain: str) -> bool:
    """Atomically add `domain` to the in-flight set if not already there.
    Returns True if we got the slot (start pipeline), False if already running.
    """
    with _inflight_lock:
        if domain in _inflight_domains:
            return False
        _inflight_domains.add(domain)
        return True


def _release_slot(domain: str) -> None:
    with _inflight_lock:
        _inflight_domains.discard(domain)


def _check_cancel(domain: str) -> bool:
    """Return True if the user has requested cancellation for this domain.
    Checked between pipeline steps — can't forcibly stop a running HTTP
    request, but we can stop BEFORE the next expensive step.
    """
    from database import get_domain as _gd
    d = _gd(domain)
    return bool(d and d["cancel_requested"])


class PipelineCanceled(Exception):
    """Raised by the worker when cancel_requested transitions to 1 mid-run."""
    pass


def run_full_pipeline(domain, skip_purchase=False, server_id=None,
                      start_from=None):
    """Kick off the full pipeline in a daemon thread; returns the thread or
    `None` if a pipeline for this domain is already running.
    """
    if not _try_acquire_slot(domain):
        log_pipeline(domain, "pipeline", "warning",
                     "Pipeline start ignored — another run is already in progress")
        return None
    thread = threading.Thread(
        target=_pipeline_worker,
        args=(domain, skip_purchase, server_id, start_from),
        daemon=True,
    )
    thread.start()
    return thread


def run_bulk_pipeline(domains, skip_purchase=False, server_id=None):
    """Run pipeline for multiple domains sequentially (avoids rate limits)."""
    thread = threading.Thread(
        target=_bulk_worker,
        args=(domains, skip_purchase, server_id),
        daemon=True,
    )
    thread.start()
    return thread


def _bulk_worker(domains, skip_purchase, server_id):
    for d in domains:
        if not _try_acquire_slot(d):
            log_pipeline(d, "pipeline", "warning",
                         "Bulk skip — another pipeline already running for this domain")
            continue
        try:
            _pipeline_worker(d, skip_purchase, server_id, None)
        finally:
            # _pipeline_worker releases the slot itself on exit; no-op here,
            # but guard against an unexpected synchronous-path error.
            _release_slot(d)


# ---------------------------------------------------------------------------
# Main worker — ten steps, sequential, resumable
# ---------------------------------------------------------------------------

class HeartbeatTicker:
    """Context manager: spawns a daemon that pulses heartbeat(domain) every
    `interval` seconds while a long-running worker is active, so the watcher
    UI can distinguish 'still working' from 'crashed/dead'. Used by the
    pipeline worker, the teardown worker, and the migrator.

    Accepts either a single domain string OR an iterable of domains. The
    latter is what migrate_server uses to keep EVERY domain on a dead
    server heartbeating in parallel while the target replacement droplet
    is being provisioned (5–15 min for a fresh SA agent install).
    """
    def __init__(self, domain, interval=1.0):
        if isinstance(domain, str):
            self.domains = [domain]
        else:
            self.domains = list(domain)
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None

    # Back-compat alias for code that used to read ticker.domain
    @property
    def domain(self):
        return self.domains[0] if self.domains else None

    def __enter__(self):
        def _loop():
            while not self._stop.is_set():
                for d in self.domains:
                    try: heartbeat(d)
                    except Exception: pass
                self._stop.wait(self.interval)
        name = ("heartbeat-" + self.domains[0]) if self.domains else "heartbeat-none"
        if len(self.domains) > 1:
            name += f"+{len(self.domains)-1}"
        self._thread = threading.Thread(target=_loop, daemon=True, name=name)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread: self._thread.join(timeout=2)
        return False


def _pipeline_worker(domain, skip_purchase, server_id, start_from):
    try:
        with HeartbeatTicker(domain, interval=1.0):
            _pipeline_worker_impl(domain, skip_purchase, server_id, start_from)
    finally:
        # Always clear the cancel flag on exit so a late-arriving cancel
        # (set after the last _check_cancel boundary) can't sticky into the
        # next run and self-cancel it at step 1.
        try: update_domain(domain, cancel_requested=0)
        except Exception: pass
        _release_slot(domain)


def _pipeline_worker_impl(domain, skip_purchase, server_id, start_from):
    try:
        add_domain(domain)
        init_steps(domain)
        log_pipeline(domain, "pipeline", "running", "Pipeline v2 started")

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 1 — Buy / Detect Domain =====================================
        if start_from is None or start_from <= 1:
            ok1 = _step1_buy_or_detect(domain, skip_purchase)
            if not ok1:
                return
        else:
            update_step(domain, 1, "skipped", "start_from > 1")

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 2 — Assign Cloudflare Key ===================================
        if start_from is None or start_from <= 2:
            if not _step2_assign_cf_key(domain):
                return

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 3 — Create Zone in Cloudflare ===============================
        if start_from is None or start_from <= 3:
            if not _step3_create_zone(domain):
                return

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 4 — Set Nameservers =========================================
        if start_from is None or start_from <= 4:
            if not _step4_set_nameservers(domain):
                return

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 5 — Wait for Zone Active (short, non-blocking) =============
        # NS propagation can take 5-30 min. Rather than blocking the whole
        # pipeline, we do a brief poll (2 min) and then continue regardless.
        # The site gets provisioned + hosted; the live_checker flips status
        # to "live" later once https://domain/ actually responds with 200.
        if start_from is None or start_from <= 5:
            _step5_wait_zone_active(domain, timeout=120, poll=15)

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 6 — Pick / Provision Server =================================
        if start_from is None or start_from <= 6:
            server = _step6_get_or_provision_server(domain, server_id)
            if not server:
                return
        else:
            # Resuming past step 6 — must operate on the domain's existing
            # server, not a random eligible one. Honor an explicit server_id
            # from the UI; otherwise look up the server stored on the domain
            # row when steps 1-6 originally ran.
            resume_id = server_id
            if resume_id is None:
                d = get_domain(domain)
                resume_id = d and d["server_id"]
            server = _find_server(resume_id) if resume_id else None
            if not server:
                log_pipeline(domain, "pipeline", "failed",
                             f"Cannot resume from step {start_from}: no server "
                             "associated with this domain. Re-run from step 6 "
                             "or pick a server explicitly.")
                update_domain(domain, status="error")
                return

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 7 — Create Site on ServerAvatar =============================
        if start_from is None or start_from <= 7:
            if not _step7_create_app_and_dns(domain, server):
                return

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 8 — Issue & Install Origin SSL ==============================
        if start_from is None or start_from <= 8:
            if not _step8_issue_and_install_ssl(domain, server):
                # ssl step is warn-on-fail (domain still works on Flexible SSL)
                pass

        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 9 — Generate Site Content (LLM) =============================
        php = None
        if start_from is None or start_from <= 9:
            php = _step9_generate_content(domain)
            if php is None:
                # Either blocked or failed — worker already updated status. Stop.
                return
        else:
            # Resuming at step 10 — load previously generated content from
            # domain.site_html (filled by step 9). Fall back to the on-disk
            # archive if site_html got cleared. If neither exists, fail loud
            # rather than uploading None.
            d = get_domain(domain)
            php = (d and d["site_html"]) or None
            if not php or len(php) < 100:
                from modules.migration import read_archive
                archived = read_archive(domain)
                if archived is not None:
                    php, _ = archived
            if not php or len(php) < 100:
                log_pipeline(domain, "pipeline", "failed",
                             "Cannot resume from step 10: no generated content "
                             "found (site_html empty and no archive). Re-run "
                             "from step 9 to regenerate.")
                update_domain(domain, status="error")
                return

        if _check_cancel(domain): raise PipelineCanceled()
        if _check_cancel(domain): raise PipelineCanceled()
        # ===== STEP 10 — Upload index.php =======================================
        if start_from is None or start_from <= 10:
            if not _step10_upload_index_php(domain, server, php):
                return

        log_pipeline(domain, "pipeline", "completed", f"Pipeline v2 complete for {domain}")

    except PipelineCanceled:
        log_pipeline(domain, "pipeline", "warning",
                     "Pipeline CANCELED by user before completion")
        update_domain(domain, status="canceled", cancel_requested=0)
        return
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        # Log the one-liner (readable in pipeline_log) + the full traceback
        # (truncated to 4 KB so it fits in the log row) for post-mortem.
        log_pipeline(domain, "pipeline", "failed",
                     f"Unhandled pipeline error: {type(e).__name__}: {e}\n\n{tb[:4000]}")
        update_domain(domain, status="error")
        try:
            from modules.notify import notify_pipeline_failure
            # Alerts get just the summary — full tb lives in pipeline_log.
            notify_pipeline_failure(domain, "pipeline",
                                    f"{type(e).__name__}: {e}")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Step implementations — each is a small function, logs its own events.
# ---------------------------------------------------------------------------

def _step1_buy_or_detect(domain, skip_purchase):
    """Check availability / ownership, buy if needed, else mark BYO."""
    d = get_domain(domain)
    if d and d["status"] in ("purchased", "owned") or (d and d["status"] not in ("pending", None)):
        # Already past step 1 — no-op
        update_step(domain, 1, "skipped", f"Already: {d['status']}")
        return True

    update_step(domain, 1, "running", "Checking domain availability / ownership...")
    try:
        avail = spaceship.check_availability([domain])
        # Spaceship returns a list with {name, available: bool, premium?, ...}
        entries = avail if isinstance(avail, list) else (avail.get("domains") or avail.get("data") or [])
        info = next((e for e in entries if e.get("name", "").lower() == domain.lower()),
                    entries[0] if entries else {})
        is_available = bool(info.get("available") or info.get("isAvailable"))
    except Exception as e:
        update_step(domain, 1, "failed", f"availability check failed: {e}")
        update_domain(domain, status="error")
        return False

    if is_available:
        if skip_purchase:
            update_step(domain, 1, "warning",
                        "Domain is available but skip_purchase=true — please buy it manually, then rerun")
            update_domain(domain, status="pending")
            return False
        # Actually buy it
        update_step(domain, 1, "running", f"{domain} is available — purchasing via Spaceship...")
        ok, result = spaceship.purchase_domain(domain)
        if not ok:
            update_step(domain, 1, "failed", f"purchase failed: {str(result)[:200]}")
            update_domain(domain, status="purchase_failed")
            return False
        update_step(domain, 1, "completed", "Purchased via Spaceship")
        update_domain(domain, status="purchased")
        return True

    # Unavailable — is it in OUR Spaceship account? Spaceship caps `take` at 25
    # per page so we have to paginate. Bail early as soon as we find a match.
    found_here = False
    try:
        skip = 0
        for _page in range(40):  # safety cap: 1000 domains
            resp = spaceship.list_domains(take=25, skip=skip)
            items = resp.get("items") or resp.get("data") or []
            if any((it.get("name") or "").lower() == domain.lower() for it in items):
                found_here = True
                break
            if len(items) < 25:
                break
            skip += 25
    except Exception as e:
        log_pipeline(domain, "detect", "warning",
                     f"Spaceship list_domains paging stopped: {e}")
    if found_here:
        update_step(domain, 1, "completed",
                    "Bring-your-own (found in Spaceship account)")
        update_domain(domain, status="owned")
        return True

    # Not ours, not available — external registrar
    update_step(domain, 1, "warning",
                "Domain is registered elsewhere. We'll still create the CF zone; "
                "you must manually update NS at your registrar when we reach step 4.")
    update_domain(domain, status="owned_external")
    return True


def _step2_assign_cf_key(domain):
    d = get_domain(domain)
    if d and d["cf_key_id"]:
        update_step(domain, 2, "skipped", f"CF key already assigned: {d['cf_email']}")
        return True
    update_step(domain, 2, "running", "Picking next CF key from pool...")
    try:
        key = assign_cf_key_to_domain(domain)
        update_step(domain, 2, "completed",
                    f"Assigned {key['alias'] or key['email']} (used {key['domains_used']}/{key['max_domains']})")
        update_domain(domain, status="cf_assigned")
        return True
    except CFKeyPoolExhausted as e:
        update_step(domain, 2, "failed", f"CF key pool exhausted: {e}")
        update_domain(domain, status="cf_pool_full")
        log_pipeline(domain, "pipeline", "failed",
                     "CF key pool full — add a new CF key in dashboard and re-run")
        return False
    except Exception as e:
        update_step(domain, 2, "failed", str(e))
        update_domain(domain, status="error")
        return False


def _step3_create_zone(domain):
    d = get_domain(domain)
    if d and d["cf_zone_id"] and d["cf_nameservers"]:
        update_step(domain, 3, "skipped", f"Zone already exists: {d['cf_zone_id']}")
        return True
    update_step(domain, 3, "running", "Adding zone to Cloudflare...")
    try:
        info = cloudflare_api.create_zone_for_domain(domain)
        update_step(domain, 3, "completed",
                    f"zone={info['zone_id'][:12]}… NS={','.join(info['nameservers'])}")
        update_domain(domain, status="zone_created")
        return True
    except Exception as e:
        update_step(domain, 3, "failed", str(e)[:400])
        update_domain(domain, status="error")
        return False


def _step4_set_nameservers(domain):
    d = get_domain(domain)
    if not d or not d["cf_nameservers"]:
        update_step(domain, 4, "failed", "No cf_nameservers set on domain row")
        return False
    nameservers = [n.strip() for n in d["cf_nameservers"].split(",") if n.strip()]

    # If external registrar, we can't push NS — show instructions and continue
    if d["status"] == "owned_external":
        update_step(domain, 4, "warning",
                    f"Manual action required at external registrar: set NS to {', '.join(nameservers)}")
        # Don't fail — user can fix later and re-run step 5
        update_domain(domain, status="ns_pending_external")
        return True

    update_step(domain, 4, "running", f"Setting NS on Spaceship: {', '.join(nameservers)}")
    try:
        ok = spaceship.set_nameservers(domain, nameservers)
        if not ok:
            update_step(domain, 4, "failed", "Spaceship set_nameservers returned false")
            return False
        update_step(domain, 4, "completed", f"NS updated: {', '.join(nameservers)}")
        update_domain(domain, status="ns_set")
        return True
    except Exception as e:
        update_step(domain, 4, "failed", str(e)[:400])
        return False


def _step5_wait_zone_active(domain, timeout=600, poll=30):
    """Warn-only: proceeds after timeout even if still pending."""
    d = get_domain(domain)
    if d and d["status"] in ("zone_active", "app_created", "ssl_installed", "live"):
        update_step(domain, 5, "skipped", "Zone already active")
        return True
    update_step(domain, 5, "running", "Polling Cloudflare zone status...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = cloudflare_api.get_zone_status(domain)
            if s == "active":
                update_step(domain, 5, "completed", "Zone ACTIVE")
                update_domain(domain, status="zone_active")
                return True
            update_step(domain, 5, "running",
                        f"Zone status: {s}  ({int(time.time() - (deadline - timeout))}s/{timeout}s)")
        except Exception:
            pass
        time.sleep(poll)
    update_step(domain, 5, "warning",
                f"Zone not active after {timeout}s — continuing; may need re-run later")
    return False


def _step6_get_or_provision_server(domain, explicit_server_id=None):
    """Return a ready server with capacity, else provision a new one."""
    server = _find_server(explicit_server_id)
    if server:
        update_step(domain, 6, "completed",
                    f"Using existing server #{server['id']} {server['name']} ({server['ip']})  "
                    f"sites={server.get('sites_count',0)}/{server.get('max_sites',60)}")
        return server

    # Provision new droplet
    update_step(domain, 6, "running", "No server with capacity — provisioning new DO droplet...")
    try:
        server_name = f"ssr-{int(time.time())}-{random.randint(1000,9999)}"
        server_id_db, ip, droplet_id = digitalocean.create_droplet(server_name)
        update_step(domain, 6, "running",
                    f"Droplet {droplet_id} up at {ip} — installing ServerAvatar agent (5-15 min)...")
        sa_server_id = serveravatar.install_agent_on_droplet(ip, server_name)
        # mark server ready
        from database import update_server
        update_server(server_id_db, sa_server_id=sa_server_id, status="ready")
        update_step(domain, 6, "completed",
                    f"Provisioned server #{server_id_db} {server_name} ({ip})  sa_id={sa_server_id}")
        # return fresh row as a dict so `.get()` calls downstream keep working
        for s in get_servers():
            if s["id"] == server_id_db:
                return dict(s)
    except digitalocean.DOAllTokensFailed as e:
        # Both primary + backup DO tokens rejected the request. This is the
        # account-level DR scenario — show each attempt explicitly so the
        # user can see that EVERY configured token failed and act on it.
        msg = (f"Provisioning failed: all DO tokens rejected the request. "
               f"Attempts: {'; '.join(f'{lbl}→{err}' for lbl, err in e.attempts)}")
        update_step(domain, 6, "failed", msg)
        log_pipeline(domain, "provision", "failed", msg)
        # Critical: fire a multi-channel alert since auto-migrate can't
        # provision replacements until a token works again.
        try:
            from modules.notify import notify_do_all_failed
            notify_do_all_failed(
                context=f"step 6 provision for domain={domain}",
                attempts=e.attempts,
            )
        except Exception:
            pass
    except digitalocean.DropletRateLimited as e:
        # Cost cap hit. Fire an alert with the recent count so the user
        # knows exactly why — this is almost always caused by an
        # auto-migrate storm on a shared DO outage.
        msg = f"Droplet creation refused by cost cap: {e}"
        update_step(domain, 6, "failed", msg)
        log_pipeline(domain, "provision", "failed", msg)
        try:
            from modules.notify import notify
            info = digitalocean.recent_droplet_creations()
            notify(
                "Droplet cost-cap hit",
                f"{info['last_hour']} droplets created in the last hour "
                f"(cap={info['cap']}). New provisioning BLOCKED until an hour "
                f"passes or you raise the cap in Settings.\n\n"
                f"This usually means an auto-migrate storm is in progress. "
                f"Investigate before lifting the cap.",
                severity="error",
                dedupe_key="droplet_cost_cap",
            )
        except Exception:
            pass
    except Exception as e:
        update_step(domain, 6, "failed", f"Provisioning failed: {e}")
        log_pipeline(domain, "provision", "failed", str(e))
    return None


def _step7_create_app_and_dns(domain, server):
    """Create SA app + point A record for the apex and www to the server IP."""
    d = get_domain(domain)
    if d and d["status"] in ("app_created", "ssl_installed", "live") and d["current_proxy_ip"] == server["ip"]:
        update_step(domain, 7, "skipped", "App already exists + DNS already set")
        return True

    # Create the app on ServerAvatar
    update_step(domain, 7, "running", f"Creating SA app for {domain} on {server['name']}...")
    try:
        app_id = serveravatar.create_application(server["sa_server_id"], domain)
    except Exception as e:
        update_step(domain, 7, "failed", f"SA create_application: {e}")
        update_domain(domain, status="error")
        return False
    update_domain(domain, server_id=server["id"])

    # Set A records (apex + www) pointing to the server IP, proxied (orange cloud)
    update_step(domain, 7, "running", f"Setting DNS A records → {server['ip']} (proxied)")
    try:
        cloudflare_api.setup_domain_dns(domain, server["ip"])
    except Exception as e:
        update_step(domain, 7, "failed", f"CF DNS setup: {e}")
        update_domain(domain, status="error")
        return False

    # sites_count is computed on-read from domains.server_id — no bump needed.
    update_domain(domain, status="app_created", current_proxy_ip=server["ip"])

    # Cache the CF apex+www A-record IDs so dead-server migration can PATCH
    # them in O(1) instead of list+search. Non-fatal if it fails.
    try:
        from modules.migration import capture_cf_record_ids
        capture_cf_record_ids(domain)
    except Exception as e:
        log_pipeline(domain, "cf_record_capture", "warning",
                     f"Could not cache record IDs (non-fatal): {e}")

    update_step(domain, 7, "completed",
                f"App id={app_id} created + DNS → {server['ip']} (orange cloud)")
    return True


def _step8_issue_and_install_ssl(domain, server):
    d = get_domain(domain)
    if d and d["status"] in ("ssl_installed", "live"):
        update_step(domain, 8, "skipped", "SSL already installed")
        return True

    update_step(domain, 8, "running", "Issuing Origin CA cert (15y) from Cloudflare...")
    try:
        bundle = cloudflare_api.fetch_origin_ca_cert(domain)
    except Exception as e:
        update_step(domain, 8, "warning", f"Origin CA issuance failed: {e}")
        return False

    # Cache the Origin cert + private key so migration can reinstall the same
    # cert on a new server without asking CF to re-issue (saves ~30s per
    # migrated domain and preserves the 15-year validity window).
    try:
        from modules.migration import save_origin_cert
        save_origin_cert(domain, bundle["certificate"], bundle["private_key"])
    except Exception as e:
        log_pipeline(domain, "origin_cert_cache", "warning",
                     f"Could not cache cert (non-fatal): {e}")

    # --- Briefly grey-cloud the A record so SA's Let's Encrypt verification
    # resolves the domain to our origin IP directly (not CF's edge). Without
    # this, SA's `/ssl` POST refuses with "Please wait while the DNS
    # propagation is done." Once the SSL is installed we restore the proxy.
    update_step(domain, 8, "running",
                "Temporarily grey-clouding DNS for SA SSL verification...")
    try:
        cloudflare_api.set_dns_a_record(domain, server["ip"], proxied=False)
        cloudflare_api.set_dns_a_record_www(domain, server["ip"], proxied=False)
        # Give CF edge ~30s to stop proxying so LE resolvers see the real IP
        time.sleep(30)
    except Exception as e:
        log_pipeline(domain, "cf_grey_cloud", "warning", f"grey-cloud failed: {e}")

    # --- Install the custom cert via SA's proper auto→destroy→custom flow.
    # install_custom_ssl will fall back to SSH if the API still refuses. ----
    install_ok, install_msg = False, ""
    try:
        app_id = serveravatar._find_app_id(server["sa_server_id"], domain)
        if not app_id:
            raise RuntimeError("App not found on SA server for SSL install")
        install_ok, install_msg = serveravatar.install_custom_ssl(
            server["sa_server_id"], app_id,
            bundle["certificate"], bundle["private_key"], bundle["chain"],
            force_https=True,
            domain=domain, server_ip=server["ip"],
        )
    except Exception as e:
        install_msg = f"install error: {e}"
    finally:
        # --- ALWAYS restore the orange cloud, even if install errored out.
        # Leaving the zone grey-clouded after a failure would expose the
        # origin IP indefinitely.
        try:
            cloudflare_api.set_dns_a_record(domain, server["ip"], proxied=True)
            cloudflare_api.set_dns_a_record_www(domain, server["ip"], proxied=True)
        except Exception as e:
            log_pipeline(domain, "cf_orange_cloud_restore", "failed",
                         f"could not re-enable proxy: {e}")

    if install_ok:
        update_step(domain, 8, "completed", f"SSL installed ({install_msg})")
        update_domain(domain, status="ssl_installed")
        return True
    update_step(domain, 8, "warning",
                f"SA SSL install failed: {install_msg}  — site still reachable "
                f"(CF is orange-clouded, cert may be installed via SSH fallback)")
    return False


def _step9_generate_content(domain):
    d = get_domain(domain)
    if d and d["site_html"] and len(d["site_html"]) > 100:
        update_step(domain, 9, "skipped", "Content already generated")
        return d["site_html"]
    update_step(domain, 9, "running", "Generating single-page site (Haiku 4.5)...")
    try:
        result = website_generator.generate_single_page(domain)
        php = result.get("php", "")
        niche = result.get("inferred_niche", "")
        update_domain(domain, site_html=php)
        update_step(domain, 9, "completed",
                    f"Generated (niche='{niche}'  bytes={len(php)})")
        return php
    except ContentBlockedError as e:
        update_step(domain, 9, "failed",
                    f"CONTENT BLOCKED — niche='{e.inferred_niche}'  reason={e.reason}")
        update_domain(domain, status="content_blocked")
        log_pipeline(domain, "pipeline", "blocked", f"Blocked: {e.reason}")
        return None
    except Exception as e:
        update_step(domain, 9, "failed", f"LLM error: {e}")
        update_domain(domain, status="error")
        return None


def _step10_upload_index_php(domain, server, php):
    update_step(domain, 10, "running", f"Writing index.php to {server['name']}...")
    try:
        serveravatar.upload_index_php(server["sa_server_id"], domain, php)

        # Archive the generated content locally so dead-server migration can
        # re-upload it without paying the LLM or waiting on generation again.
        try:
            from modules.migration import archive_site
            archive_site(domain, php)
        except Exception as e:
            log_pipeline(domain, "archive", "warning",
                         f"Archive save failed (non-fatal): {e}")

        # Status is "hosted" (not "live") at this point — the live_checker
        # background thread will flip it to "live" once the site actually
        # responds to HTTPS (after NS propagates, CF activates, etc.).
        update_domain(domain, status="hosted")
        update_step(domain, 10, "completed",
                    f"Hosted on {server['ip']}. Dashboard will flip to 'live' "
                    f"once https://{domain}/ responds (usually a few min).")
        return True
    except Exception as e:
        update_step(domain, 10, "failed", str(e))
        update_domain(domain, status="error")
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_server(explicit_id=None):
    """Return a ready server with free capacity; honor explicit_id if given.

    Round-robin across eligible servers to distribute load. Converts SQLite
    Row objects to dicts up front so `.get()` works consistently everywhere
    downstream (step_tracker messages etc.).

    F8: before returning a server, ping SA to confirm its sa_server_id is
    still valid. If SA returns 404 (user manually deleted the server in the
    SA dashboard), mark the row 'dead' in our DB and try the next one. This
    self-heals stale server rows instead of letting the pipeline 404 at
    step 7.
    """
    servers = [dict(s) for s in get_servers()]
    if explicit_id:
        for s in servers:
            if s["id"] == int(explicit_id):
                if _verify_sa_server_or_mark_dead(s):
                    return s
                return None
    eligible = [
        s for s in servers
        if (s.get("status") == "ready"
            and s.get("sa_server_id")
            and (s.get("sites_count") or 0) < (s.get("max_sites") or 60))
    ]
    # Randomised round-robin; skip any server whose SA backend has vanished.
    random.shuffle(eligible)
    for s in eligible:
        if _verify_sa_server_or_mark_dead(s):
            return s
    return None


def _verify_sa_server_or_mark_dead(server: dict) -> bool:
    """Ping SA for server.sa_server_id; if 404, flip the row to 'dead' in DB
    and return False so the caller skips it. Returns True if SA knows it.
    """
    sa_id = server.get("sa_server_id")
    if not sa_id:
        return False
    try:
        if serveravatar.is_sa_server_alive(sa_id):
            return True
    except Exception:
        # Network glitches shouldn't mark a server dead — be generous here.
        return True
    # Explicit 404: server no longer exists on SA.
    from database import get_db
    conn = get_db()
    try:
        conn.execute("UPDATE servers SET status='dead' WHERE id=?",
                     (server["id"],))
        conn.commit()
    finally:
        conn.close()
    log_pipeline(f"server-{server['id']}", "sa_health", "warning",
                 f"Server #{server['id']} ({server.get('name')} / "
                 f"{server.get('ip')}) flipped to DEAD — SA no longer "
                 f"has sa_server_id={sa_id}")
    return False


