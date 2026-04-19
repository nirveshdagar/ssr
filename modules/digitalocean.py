"""
DigitalOcean API — create and manage droplets for site hosting.

Dual-token failover: every request tries the PRIMARY token first, and
automatically retries with the BACKUP token on auth failures (401/403),
server errors (5xx), or network timeouts. This keeps droplet provisioning
working even when the primary account is suspended, rate-limited, or the
primary token was revoked.

Configure from Settings:
  - do_api_token          primary DO personal access token
  - do_api_token_backup   backup DO PAT (typically a second account)
  - do_use_backup_first   "1" to flip the order — try backup first (useful
                          when you know the primary is broken and don't
                          want every call to eat an auth-fail round-trip)
"""

import threading
import time
import random
import requests
from database import (
    get_setting, set_setting, add_server, update_server, log_pipeline, get_db,
)

# --- Cost-runaway cap (issue #3) ---
# Rolling window of recent droplet creations. If more than
# `max_droplets_per_hour` have been provisioned in the last 3600s, any new
# create_droplet() call raises DropletRateLimited immediately — no API spend,
# no silent cost explosion from an auto-migrate storm.
_DEFAULT_MAX_DROPLETS_PER_HOUR = 3
_droplet_creations: list[float] = []
_droplet_lock = threading.Lock()


class DropletRateLimited(Exception):
    """Raised when the local cost-cap would be exceeded. Caller (step 6 /
    migrate_server) should treat this like DOAllTokensFailed — alert the
    user, don't retry, don't loop."""
    pass


def _check_and_record_creation():
    """Atomically check the rolling window + record this creation.

    Raises DropletRateLimited if we'd exceed the cap. Use BEFORE calling
    the actual POST /droplets so we don't pay for a doomed provision.
    """
    try:
        cap = int(get_setting("max_droplets_per_hour")
                  or _DEFAULT_MAX_DROPLETS_PER_HOUR)
    except (TypeError, ValueError):
        cap = _DEFAULT_MAX_DROPLETS_PER_HOUR
    now = time.time()
    with _droplet_lock:
        # Purge entries older than 1 hour
        _droplet_creations[:] = [t for t in _droplet_creations if now - t < 3600]
        if len(_droplet_creations) >= cap:
            raise DropletRateLimited(
                f"Refusing to create droplet: {len(_droplet_creations)} "
                f"already created in the last hour (cap={cap}). "
                f"Raise `max_droplets_per_hour` in Settings if this is intentional."
            )
        _droplet_creations.append(now)


def recent_droplet_creations() -> dict:
    """For dashboard display: how many droplets have we created recently?"""
    now = time.time()
    with _droplet_lock:
        recent = [t for t in _droplet_creations if now - t < 3600]
    return {
        "last_hour": len(recent),
        "cap": int(get_setting("max_droplets_per_hour")
                   or _DEFAULT_MAX_DROPLETS_PER_HOUR),
    }

DO_API = "https://api.digitalocean.com/v2"

# Errors that trigger the backup-token retry. Anything not in this set
# (e.g., 404 "droplet not found", 422 "invalid region") is a real error
# and should propagate — not a signal to fail over.
_FAILOVER_STATUSES = {401, 403, 500, 502, 503, 504, 520, 521, 522, 523, 524}


class DOAllTokensFailed(Exception):
    """Raised when BOTH primary and backup tokens fail the same request.

    Carries `attempts: list[tuple[str, str]]` of (token_label, error_msg)
    so callers (auto-migrate logs, dashboard) can show which token failed
    with which reason.
    """
    def __init__(self, attempts):
        self.attempts = attempts
        lines = "; ".join(f"{lbl}: {err}" for lbl, err in attempts)
        super().__init__(f"All DO tokens failed — {lines}")


def _candidate_tokens():
    """Return list of (label, token) tuples in the order we should try them.

    Skips empty tokens. If `do_use_backup_first` is set, reverses the order
    so the backup token leads.
    """
    primary = (get_setting("do_api_token") or "").strip()
    backup  = (get_setting("do_api_token_backup") or "").strip()
    order = []
    if primary:
        order.append(("primary", primary))
    if backup:
        order.append(("backup", backup))
    if (get_setting("do_use_backup_first") or "0") == "1":
        order.reverse()
    if not order:
        raise ValueError(
            "No DigitalOcean API token configured. "
            "Set `do_api_token` (and optionally `do_api_token_backup`) in Settings."
        )
    return order


def _token_headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _is_failover_error(exc_or_resp):
    """Decide whether this failure should trigger a backup retry."""
    if isinstance(exc_or_resp, requests.Response):
        return exc_or_resp.status_code in _FAILOVER_STATUSES
    # Exception cases: timeouts, connection errors, SSL errors — all failover
    return isinstance(exc_or_resp, (
        requests.Timeout, requests.ConnectionError, requests.exceptions.SSLError,
    ))


def _do_request(method, path, *, raise_for_status=True, **kwargs):
    """Issue a DO API call with token failover.

    method: "GET"/"POST"/"DELETE" etc.
    path:   URL path starting with "/" (e.g. "/droplets")
    kwargs: passed through to requests (json=, params=, timeout=)

    Returns the successful Response. Stores which token worked to
    `do_last_working_token` setting so the UI can show it.
    """
    attempts = []
    last_response_holder = {}
    url = f"{DO_API}{path}"
    timeout = kwargs.pop("timeout", 60)

    for label, token in _candidate_tokens():
        try:
            resp = requests.request(
                method, url,
                headers=_token_headers(token),
                timeout=timeout,
                **kwargs,
            )
        except requests.RequestException as e:
            if _is_failover_error(e):
                attempts.append((label, f"{type(e).__name__}: {e}"))
                continue
            # Non-failover network error — surface it immediately.
            attempts.append((label, f"{type(e).__name__}: {e}"))
            raise DOAllTokensFailed(attempts)

        if resp.ok:
            # Remember which token succeeded so the UI can display it.
            try:
                set_setting("do_last_working_token", label)
            except Exception:
                pass
            return resp

        if _is_failover_error(resp):
            # Capture for diagnostics but try the next token.
            body = (resp.text or "")[:200].replace("\n", " ")
            attempts.append((label, f"HTTP {resp.status_code} — {body}"))
            last_response_holder["r"] = resp
            continue

        # Non-failover HTTP error (e.g., 404, 422) — real error, don't try backup.
        if raise_for_status:
            resp.raise_for_status()
        return resp

    # Fell through: nothing succeeded. If we have a captured response
    # (HTTP error the caller might want to inspect) raise the custom
    # exception with full attempt history.
    raise DOAllTokensFailed(attempts)


def _headers():
    """Back-compat shim — returns headers built from whichever token is
    tried first. Prefer _do_request for new code since it handles failover.
    Kept so external modules still calling _headers() keep working.
    """
    for _label, token in _candidate_tokens():
        return _token_headers(token)
    raise ValueError("DigitalOcean API token not configured. Go to Settings.")


def test_tokens():
    """Ping both tokens against /account — returns {"primary": {...}, "backup": {...}}.
    Each entry is {"configured": bool, "ok": bool, "email": str, "error": str}.
    """
    out = {}
    for label, key in (("primary", "do_api_token"), ("backup", "do_api_token_backup")):
        tok = (get_setting(key) or "").strip()
        if not tok:
            out[label] = {"configured": False, "ok": False,
                          "email": "", "error": "not configured"}
            continue
        try:
            r = requests.get(f"{DO_API}/account",
                             headers=_token_headers(tok), timeout=15)
            if r.ok:
                data = r.json().get("account", {})
                out[label] = {"configured": True, "ok": True,
                              "email": data.get("email", "?"),
                              "status": data.get("status", "?"),
                              "droplet_limit": data.get("droplet_limit"),
                              "error": ""}
            else:
                out[label] = {"configured": True, "ok": False,
                              "email": "", "error": f"HTTP {r.status_code}: {r.text[:120]}"}
        except Exception as e:
            out[label] = {"configured": True, "ok": False,
                          "email": "", "error": f"{type(e).__name__}: {e}"}
    return out


def _build_user_data(root_password):
    """cloud-init user_data to set root password and enable SSH password auth.

    DO doesn't have a direct "password" field at droplet creation; cloud-init
    runs on first boot and does the equivalent. This ensures every droplet
    comes up with the configured root password + SSH password login enabled,
    so our automation can SSH in without key setup.
    """
    # Escape any `$` or backticks in the password to survive shell interpolation
    safe_pw = root_password.replace("\\", "\\\\").replace('"', '\\"')
    return f"""#cloud-config
chpasswd:
  list: |
    root:{safe_pw}
  expire: false
ssh_pwauth: true
disable_root: false
runcmd:
  - sed -i 's/^#\\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
  - sed -i 's/^#\\?PermitRootLogin .*/PermitRootLogin yes/' /etc/ssh/sshd_config
  - systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true
"""


def _pick_region():
    """Random choice from the DB-configured US regions pool. Falls back to nyc3."""
    pool_str = get_setting("server_regions_pool") or "nyc1,nyc3,sfo2"
    regions = [r.strip() for r in pool_str.split(",") if r.strip()]
    return random.choice(regions) if regions else "nyc3"


def create_droplet(name, region=None, size=None, image="ubuntu-24-04-x64",
                   root_password=None):
    """Create a DigitalOcean droplet with cloud-init-set root password.

    Args:
      name: droplet hostname and DB row name
      region: DO region slug; if None → random from `server_regions_pool` setting
      size: DO size slug; if None → reads `server_droplet_size` setting
            (defaults to s-2vcpu-8gb-160gb-intel per project spec)
      image: Ubuntu image slug (must support cloud-init — default is fine)
      root_password: root password to set via cloud-init; if None → reads
                     `server_root_password` setting

    Returns: (server_id_in_db, droplet_ip, droplet_id)
    """
    # Resolve defaults from settings
    if size is None:
        size = get_setting("server_droplet_size") or "s-2vcpu-8gb-160gb-intel"
    if region is None:
        region = _pick_region()
    if root_password is None:
        root_password = get_setting("server_root_password") or ""
    if not root_password:
        raise ValueError("server_root_password not set; refusing to provision a droplet without a password")

    # Pre-flight cost cap (issue #3): refuse before burning any API call
    # if we've already created too many droplets this hour.
    _check_and_record_creation()

    log_pipeline(name, "do_create", "running",
                 f"Creating droplet: {name}  region={region}  size={size}")
    try:
        payload = {
            "name": name,
            "region": region,
            "size": size,
            "image": image,
            "ipv6": False,
            "monitoring": True,
            "tags": ["ssr-server"],
            "user_data": _build_user_data(root_password),
        }
        resp = _do_request("POST", "/droplets", json=payload, timeout=60)
        droplet = resp.json()["droplet"]
        droplet_id = str(droplet["id"])

        # Poll for IP assignment
        ip = None
        for _ in range(30):
            time.sleep(10)
            resp2 = _do_request("GET", f"/droplets/{droplet_id}", timeout=30)
            networks = resp2.json()["droplet"]["networks"]["v4"]
            for net in networks:
                if net["type"] == "public":
                    ip = net["ip_address"]
                    break
            if ip:
                break

        if not ip:
            raise RuntimeError("Droplet created but no public IP assigned after 5 minutes")

        server_id = add_server(name, ip, droplet_id)

        # Persist the new audit fields (region, size_slug, max_sites) directly —
        # add_server() pre-dates the migration and doesn't accept them.
        try:
            max_sites = int(get_setting("sites_per_server") or 60)
        except (TypeError, ValueError):
            max_sites = 60
        conn = get_db()
        try:
            conn.execute(
                "UPDATE servers SET region=?, size_slug=?, max_sites=? WHERE id=?",
                (region, size, max_sites, server_id),
            )
            conn.commit()
        finally:
            conn.close()

        log_pipeline(name, "do_create", "completed",
                     f"Droplet ready: {ip} (ID: {droplet_id})  region={region}  size={size}")
        return server_id, ip, droplet_id

    except Exception as e:
        log_pipeline(name, "do_create", "failed", str(e))
        raise


def delete_droplet(droplet_id):
    """Delete a droplet by its DO ID."""
    _do_request("DELETE", f"/droplets/{droplet_id}", timeout=30)
    return True


def list_droplets(tag="ssr-server"):
    """List droplets with the SSR tag."""
    params = {"tag_name": tag} if tag else {}
    resp = _do_request("GET", "/droplets", params=params, timeout=30)
    return resp.json().get("droplets", [])


def get_droplet(droplet_id):
    """Get droplet details."""
    resp = _do_request("GET", f"/droplets/{droplet_id}", timeout=30)
    return resp.json()["droplet"]


def list_regions():
    """List available DO regions."""
    resp = _do_request("GET", "/regions", timeout=30)
    return [r for r in resp.json()["regions"] if r["available"]]


def list_sizes():
    """List available droplet sizes."""
    resp = _do_request("GET", "/sizes", timeout=30)
    return [s for s in resp.json()["sizes"] if s["available"]]
