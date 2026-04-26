"""
SITE SERVER ROTATION — Main Flask Application
Dashboard for managing the full automation pipeline.

SECURITY FIXES in this version:
  - debug mode is now env-gated (SSR_DEBUG=1) instead of always-on
  - CSRF protection via Origin/Referer check on all POSTs
  - @login_required now decorates ALL write endpoints (defense in depth)
  - Rate limit tightened from 60→120/min but per-endpoint for expensive ones
"""

import os
import sys
import json
import secrets
import functools
import threading
import time
from urllib.parse import urlparse
from flask import Flask, render_template, request, jsonify, redirect, url_for, flash, session
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from database import (
    init_db, get_all_settings, set_setting, get_setting,
    add_domain, get_domains, get_domain, update_domain, delete_domain,
    get_servers, add_server, update_server,
    get_pipeline_logs, log_pipeline,
    get_steps, get_watcher_summary, get_all_active_watchers,
    audit, get_audit_log,
)
from modules.pipeline import run_full_pipeline, run_bulk_pipeline
from modules import live_checker as _live_checker

app = Flask(__name__)

# Persistent secret key stored in data dir (survives restarts)
_key_path = os.path.join(os.path.dirname(__file__), "data", ".secret_key")
os.makedirs(os.path.dirname(_key_path), exist_ok=True)
if os.path.exists(_key_path):
    with open(_key_path, "r") as f:
        app.secret_key = f.read().strip()
else:
    app.secret_key = secrets.token_hex(32)
    with open(_key_path, "w") as f:
        f.write(app.secret_key)

# Harden session cookies
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",   # Lax is fine for this app; Strict breaks external links
    SESSION_COOKIE_SECURE=bool(os.environ.get("SSR_HTTPS_ONLY")),  # Set SSR_HTTPS_ONLY=1 behind HTTPS
    PERMANENT_SESSION_LIFETIME=60 * 60 * 8,   # 8 hours
)

# Trust one layer of reverse-proxy headers when SSR_BEHIND_PROXY=1 is set.
# Without this, request.remote_addr is the proxy IP and rate limits are shared
# across every client. Only enable when ACTUALLY behind nginx/cloudflare/etc
# — do not enable on a direct-facing host or clients can spoof X-Forwarded-For.
if os.environ.get("SSR_BEHIND_PROXY") == "1":
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Initialize DB
init_db()

# Start the background live-checker (flips 'hosted' -> 'live' when HTTPS
# responds; 'live' -> 'hosted' on 3 consecutive failures). Idempotent.
_live_checker.start()


# R4: Grey-cloud leak recovery on boot.
# Step 8 and migrate_domain both grey-cloud the CF A-records briefly to
# install SSL, then orange them again in a `finally:` block. A SIGKILL
# between the grey and orange steps would leave the origin IP visible.
# On every startup, scan every hosted/live domain's A-records and re-enable
# proxying on any that's currently grey. Cheap: one CF GET + PATCH per
# domain that's actually in a bad state, async so boot isn't blocked.
def _grey_cloud_recovery():
    import time as _t
    from modules.cloudflare_api import (
        _get_zone_id, _headers_for_domain, _cf_request, CF_API,
    )
    # Wait a few seconds so init_db and other boot-time work settles.
    _t.sleep(5)
    restored = 0
    for d in get_domains():
        if d["status"] not in ("hosted", "live", "ssl_installed"):
            continue
        if not d["cf_zone_id"]:
            continue
        try:
            zone_id = _get_zone_id(d["domain"])
            headers = _headers_for_domain(d["domain"])
            r = _cf_request(
                "GET", f"{CF_API}/zones/{zone_id}/dns_records",
                params={"type": "A"}, headers=headers, timeout=20,
            )
            if not r.ok:
                continue
            for rec in r.json().get("result") or []:
                if rec.get("proxied") is False:
                    _cf_request(
                        "PATCH",
                        f"{CF_API}/zones/{zone_id}/dns_records/{rec['id']}",
                        json={"proxied": True}, headers=headers, timeout=20,
                    )
                    restored += 1
                    log_pipeline(d["domain"], "grey_cloud_recovery", "completed",
                                 f"Re-enabled proxy on record {rec.get('name')} "
                                 f"(was grey — origin was exposed)")
        except Exception as e:
            log_pipeline(d["domain"], "grey_cloud_recovery", "warning",
                         f"recovery check failed: {e}")
    if restored:
        log_pipeline("(startup)", "grey_cloud_recovery", "completed",
                     f"Restored orange-cloud on {restored} A-record(s) "
                     "after a prior process kill left them exposed.")


threading.Thread(target=_grey_cloud_recovery, daemon=True,
                 name="grey-cloud-recovery").start()


# Issue #7 — orphan droplet detector.
# On every boot, list every DO droplet tagged 'ssr-server' and compare
# against the servers table. Anything on DO without a DB row is an orphan
# — probably a droplet created mid-pipeline where step-6 crashed before
# we could INSERT the server row, so it's now being billed with nobody
# watching. We surface it to the user via log_pipeline + notify — we do
# NOT auto-destroy (too dangerous: user might be legitimately testing a
# droplet by hand).
def _orphan_droplet_sweep():
    import time as _t
    _t.sleep(8)  # give boot-time work + DO test a chance to settle
    try:
        from modules.digitalocean import list_droplets
        from database import get_servers as _gs
        do_droplets = list_droplets(tag="ssr-server")
        known = {str(s["do_droplet_id"]) for s in _gs() if s.get("do_droplet_id")}
        orphans = [d for d in do_droplets if str(d["id"]) not in known]
        if orphans:
            lines = [f"#{d['id']} ({d.get('name','?')} / "
                     f"{next((n['ip_address'] for n in d.get('networks',{}).get('v4',[]) if n.get('type')=='public'), '?')})"
                     for d in orphans]
            msg = (f"Found {len(orphans)} orphan DO droplet(s) tagged "
                   f"'ssr-server' with NO matching servers row:\n  " +
                   "\n  ".join(lines) +
                   "\n\nThese are likely leftover from a crashed step-6 "
                   "provision. Verify manually and destroy from DO console "
                   "if not needed (they're being billed).")
            log_pipeline("(startup)", "orphan_droplets", "warning", msg)
            try:
                from modules.notify import notify
                notify("Orphan DO droplets detected", msg,
                       severity="warning", dedupe_key="orphan_droplets_boot")
            except Exception:
                pass
    except Exception as e:
        log_pipeline("(startup)", "orphan_droplets", "warning",
                     f"sweep failed: {e}")


threading.Thread(target=_orphan_droplet_sweep, daemon=True,
                 name="orphan-droplet-sweep").start()

# Rate limiting state
_rate_limits = {}
_rate_lock = threading.Lock()


@app.after_request
def _security_headers(resp):
    """Defense-in-depth response headers (M3)."""
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Permissions-Policy",
                            "geolocation=(), microphone=(), camera=()")
    # HSTS only when actually serving over HTTPS (same env gate as Secure cookie)
    if os.environ.get("SSR_HTTPS_ONLY"):
        resp.headers.setdefault("Strict-Transport-Security",
                                "max-age=31536000; includeSubDomains")
    # CSP — permissive enough for our CDN deps (jsdelivr, Google Fonts) and
    # our own inline <script>/<style> blocks. Tightening to strict-dynamic
    # would require tagging every inline block with a nonce.
    resp.headers.setdefault("Content-Security-Policy", (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net "
        "https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    ))
    return resp


# ========================= AUTH =========================

def login_required(f):
    """Decorator — use on all write endpoints for defense in depth."""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        if _has_login_password() and not session.get("authenticated"):
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


@app.before_request
def _security_middleware():
    """Global auth gate + CSRF origin check + rate limit."""
    exempt = ("login", "static", "healthz")
    endpoint = request.endpoint or ""

    # 1) AUTH — protect everything except login/static
    if endpoint not in exempt:
        if _has_login_password() and not session.get("authenticated"):
            if request.is_json or request.path.startswith("/api/"):
                return jsonify({"error": "Unauthorized"}), 401
            if endpoint != "login":
                return redirect(url_for("login"))

    # 2) CSRF — on POSTs from an AUTHENTICATED session, require Origin or
    #    Referer to match our Host. Modern browsers always send `Origin` on
    #    cross-origin POSTs with credentials, so rejecting when BOTH headers
    #    are missing is safe (browser never ships a form POST with neither).
    #    We still allow header-less POSTs from non-authenticated sessions so
    #    scripted API use (curl without cookies) keeps working pre-login.
    if request.method == "POST" and endpoint not in ("login",):
        origin = request.headers.get("Origin", "")
        referer = request.headers.get("Referer", "")
        check = origin or referer
        is_authed = bool(session.get("authenticated"))
        if check:
            try:
                host = urlparse(check).netloc
                if host and host != request.host:
                    return jsonify({"error": "Cross-origin POST blocked"}), 403
            except Exception:
                return jsonify({"error": "Invalid Origin/Referer"}), 403
        elif is_authed:
            # Authenticated request with NEITHER Origin nor Referer — impossible
            # from a legitimate same-origin browser. Almost certainly CSRF-ish.
            return jsonify({"error": "Missing Origin/Referer on authenticated POST"}), 403

    # 3) RATE LIMIT — 120 req/min per IP, 30/min for expensive operations
    ip = request.remote_addr or "0.0.0.0"
    import time
    now = time.time()
    expensive = request.path.startswith(("/api/domains/run-", "/api/servers/create",
                                          "/api/proxies/setup"))
    limit = 30 if expensive else 120
    key = f"{ip}:{'heavy' if expensive else 'normal'}"
    with _rate_lock:
        if key not in _rate_limits:
            _rate_limits[key] = []
        _rate_limits[key] = [t for t in _rate_limits[key] if now - t < 60]
        if len(_rate_limits[key]) > limit:
            return jsonify({"error": "Rate limited"}), 429
        _rate_limits[key].append(now)


def _check_dashboard_password(submitted: str) -> bool:
    """Verify a login attempt against the stored credential.

    Transparent migration: if the DB has an old plaintext `dashboard_password`
    and no hash, accept a matching plaintext AND immediately upgrade it to a
    PBKDF2 hash so the plaintext never persists past first use.
    """
    submitted = submitted or ""
    hashed = (get_setting("dashboard_password_hash") or "").strip()
    if hashed:
        # check_password_hash is constant-time.
        try:
            return check_password_hash(hashed, submitted)
        except Exception:
            return False
    # No hash yet — check legacy plaintext for backward compat, then upgrade.
    legacy = get_setting("dashboard_password") or ""
    if not legacy:
        return True  # no password set at all — open access (unchanged behaviour)
    import hmac as _hmac
    if _hmac.compare_digest(submitted, legacy):
        # Upgrade in place: store hash, clear plaintext.
        set_setting("dashboard_password_hash",
                    generate_password_hash(submitted, method="pbkdf2:sha256",
                                           salt_length=16))
        set_setting("dashboard_password", "")
        return True
    return False


def _has_login_password() -> bool:
    """Is ANY login credential configured? (hash or legacy plaintext)"""
    return bool((get_setting("dashboard_password_hash") or "").strip()
                or (get_setting("dashboard_password") or "").strip())


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        # Throttle: per-IP failed attempts (see _login_throttle_check)
        if not _login_throttle_check(request.remote_addr or "?"):
            flash("Too many login attempts — wait a minute and try again.", "danger")
            return render_template("login.html"), 429

        pw = request.form.get("password", "")
        if _check_dashboard_password(pw):
            session["authenticated"] = True
            session.permanent = True
            _login_throttle_record(request.remote_addr or "?", ok=True)
            audit("login_ok", actor_ip=request.remote_addr or "")
            return redirect(url_for("dashboard"))

        _login_throttle_record(request.remote_addr or "?", ok=False)
        audit("login_fail", actor_ip=request.remote_addr or "")
        flash("Wrong password", "danger")
    return render_template("login.html")


# --------- Login brute-force throttle (M1) ---------
_LOGIN_MAX_PER_MIN = 5
_LOGIN_LOCKOUT_SECONDS = 60
_login_attempts: dict[str, list[float]] = {}
_login_lock = threading.Lock()


def _login_throttle_check(ip: str) -> bool:
    now = time.time()
    with _login_lock:
        attempts = _login_attempts.get(ip, [])
        # keep only last 60s of failed attempts
        attempts = [t for t in attempts if now - t < _LOGIN_LOCKOUT_SECONDS]
        _login_attempts[ip] = attempts
        return len(attempts) < _LOGIN_MAX_PER_MIN


def _login_throttle_record(ip: str, ok: bool) -> None:
    with _login_lock:
        if ok:
            _login_attempts.pop(ip, None)
        else:
            _login_attempts.setdefault(ip, []).append(time.time())


@app.route("/logout")
def logout():
    session.pop("authenticated", None)
    flash("Logged out", "info")
    return redirect(url_for("login"))


# ========================= DASHBOARD =========================

@app.route("/")
@login_required
def dashboard():
    domains = get_domains()
    servers = get_servers()
    pipe_logs = get_pipeline_logs(limit=20)
    stats = {
        "total_domains": len(domains),
        "live_domains": sum(1 for d in domains if d["status"] == "live"),
        "total_servers": len(servers),
    }
    return render_template("dashboard.html", stats=stats, domains=domains,
                           pipe_logs=pipe_logs)


# ========================= SETTINGS =========================

@app.route("/settings", methods=["GET", "POST"])
@login_required
def settings():
    if request.method == "POST":
        fields = [
            "spaceship_api_key", "spaceship_api_secret",
            "registrant_first_name", "registrant_last_name",
            "registrant_email", "registrant_phone",
            "registrant_address", "registrant_city",
            "registrant_state", "registrant_zip", "registrant_country",
            "do_api_token", "do_api_token_backup",
            "serveravatar_api_key", "serveravatar_org_id",
            "sa_dashboard_email", "sa_dashboard_password",
            "llm_provider", "llm_api_key", "llm_model",
            "llm_api_key_anthropic", "llm_api_key_openai",
            "llm_api_key_gemini", "llm_api_key_openrouter",
            "smtp_server", "smtp_port", "smtp_email", "smtp_password", "notify_email",
            "telegram_bot_token", "telegram_chat_id",
            "whatsapp_provider", "whatsapp_phone", "whatsapp_apikey",
            "greenapi_instance_id", "greenapi_api_token", "greenapi_host",
            "twilio_account_sid", "twilio_auth_token",
            "twilio_from_number", "sms_to_number",
            "server_root_password",
            "live_check_interval_s",
            "dead_server_threshold_ticks",
            "max_droplets_per_hour",
        ]
        for field in fields:
            val = request.form.get(field, "").strip()
            if val or field in request.form:
                set_setting(field, val)

        # Dashboard password is handled specially: never store plaintext.
        # Empty submission = leave existing credential alone (don't accidentally
        # blank auth just because the field rendered blank). To DISABLE auth,
        # submit literal "-" or use /logout flow.
        new_pw = (request.form.get("dashboard_password") or "").strip()
        if new_pw == "-":
            set_setting("dashboard_password_hash", "")
            set_setting("dashboard_password", "")
        elif new_pw:
            set_setting("dashboard_password_hash",
                        generate_password_hash(new_pw, method="pbkdf2:sha256",
                                               salt_length=16))
            set_setting("dashboard_password", "")  # clear legacy plaintext

        # Checkbox: only present in form when checked; normalise to "1"/"0"
        set_setting("auto_migrate_enabled",
                    "1" if request.form.get("auto_migrate_enabled") == "1" else "0")
        set_setting("do_use_backup_first",
                    "1" if request.form.get("do_use_backup_first") == "1" else "0")
        # Notification channel toggles (checkboxes)
        for ch in ("notifications_enabled", "email_enabled", "telegram_enabled",
                   "whatsapp_enabled", "sms_enabled"):
            set_setting(ch, "1" if request.form.get(ch) == "1" else "0")

        audit("settings_save", actor_ip=request.remote_addr or "",
              detail=f"{len(request.form)} fields submitted")
        flash("Settings saved successfully!", "success")
        return redirect(url_for("settings"))

    from modules.cf_key_pool import list_cf_keys
    all_settings = get_all_settings()
    cf_keys = list_cf_keys()
    return render_template("settings.html", settings=all_settings, cf_keys=cf_keys)


# ========================= DOMAINS =========================

@app.route("/domains")
@login_required
def domains_page():
    from modules.cf_key_pool import list_cf_keys
    domains = get_domains()
    servers = get_servers()
    cf_keys = list_cf_keys()
    cf_keys_by_id = {k["id"]: k for k in cf_keys}
    servers_by_id = {s["id"]: s for s in servers}
    search = request.args.get("q", "").strip().lower()
    status_filter = request.args.get("status", "").strip()
    if search:
        domains = [d for d in domains if search in d["domain"].lower()
                   or search in (d["cf_email"] or "").lower()
                   or search in (d["current_proxy_ip"] or "")]
    if status_filter:
        domains = [d for d in domains if d["status"] == status_filter]
    return render_template("domains.html", domains=domains, servers=servers,
                           cf_keys_by_id=cf_keys_by_id,
                           servers_by_id=servers_by_id,
                           search=search, status_filter=status_filter)


# ========================= CF KEY POOL =========================

@app.route("/api/cf-keys/add", methods=["POST"])
@login_required
def api_cf_keys_add():
    """Add a CF Global API Key to the pool.

    Validates the key against CF's API before storing so we never save a
    broken key to the pool. Extracts cf_account_id automatically if not provided.
    """
    from modules.cf_key_pool import add_cf_key
    import requests as _rq

    email = (request.form.get("email") or "").strip()
    api_key = (request.form.get("api_key") or "").strip()
    alias = (request.form.get("alias") or "").strip() or None

    if not email or not api_key:
        flash("Email and API key are required", "danger")
        return redirect(url_for("cloudflare_page"))

    # Live-verify by calling /accounts (that's what gives us the real Account ID
    # we need for zone creation — NOT /user, which returns the user ID).
    try:
        r = _rq.get(
            "https://api.cloudflare.com/client/v4/accounts",
            headers={"X-Auth-Email": email, "X-Auth-Key": api_key,
                     "Content-Type": "application/json"},
            timeout=15,
        )
        if r.status_code != 200:
            flash(f"CF rejected the key ({r.status_code}): {r.text[:200]}", "danger")
            return redirect(url_for("cloudflare_page"))
        accts = (r.json().get("result") or [])
        if not accts:
            flash("CF auth ok but no accounts returned — is billing set up on this CF account?",
                  "warning")
            return redirect(url_for("cloudflare_page"))
        acct_id = accts[0].get("id") or ""
    except Exception as e:
        flash(f"Could not verify CF key: {e}", "danger")
        return redirect(url_for("cloudflare_page"))

    try:
        new_id = add_cf_key(email, api_key, alias=alias, cf_account_id=acct_id)
        flash(f"Added CF key #{new_id} ({alias or email}) to pool", "success")
    except ValueError as e:
        flash(str(e), "warning")
    except Exception as e:
        flash(f"Failed to add key: {e}", "danger")
    return redirect(url_for("cloudflare_page"))


@app.route("/api/cf-keys/refresh-accounts", methods=["POST"])
@login_required
def api_cf_keys_refresh_accounts():
    """For every CF key in the pool, re-fetch the real Account ID from
    /accounts and update DB. Surfaces each key's before/after state in a
    flash message so the user can see which ones changed.
    """
    from modules.cf_key_pool import refresh_all_cf_account_ids
    results = refresh_all_cf_account_ids()
    changed = sum(1 for r in results if r["changed"])
    errored = sum(1 for r in results if r["error"])
    lines = []
    for r in results:
        if r["error"]:
            lines.append(f"  [ERR] {r['alias'] or r['email']}: {r['error'][:80]}")
        elif r["changed"]:
            lines.append(f"  [FIXED] {r['alias'] or r['email']}: {r['before'][:12]}… → {r['after'][:12]}…")
        else:
            lines.append(f"  [ok]  {r['alias'] or r['email']}: {r['after'][:12]}…")
    summary = f"{changed} fixed · {errored} errored · {len(results)-changed-errored} already correct"
    flash("CF account-ID refresh: " + summary + "\n" + "\n".join(lines),
          "warning" if errored else ("success" if changed else "info"))
    return redirect(url_for("cloudflare_page"))


@app.route("/api/cf-keys/<int:key_id>/toggle", methods=["POST"])
@login_required
def api_cf_keys_toggle(key_id):
    """Activate / deactivate a CF key in the pool (without deleting)."""
    from database import get_db
    conn = get_db()
    try:
        row = conn.execute("SELECT is_active FROM cf_keys WHERE id=?", (key_id,)).fetchone()
        if not row:
            flash("Key not found", "warning")
        else:
            new_val = 0 if row["is_active"] else 1
            conn.execute("UPDATE cf_keys SET is_active=? WHERE id=?", (new_val, key_id))
            conn.commit()
            flash(f"Key #{key_id} set to {'active' if new_val else 'inactive'}", "info")
    finally:
        conn.close()
    return redirect(url_for("cloudflare_page"))


@app.route("/cloudflare")
@login_required
def cloudflare_page():
    """Dedicated CF management page: list pool keys, add new, edit alias /
    max_domains / is_active, delete unreferenced keys, refresh account IDs.

    SECURITY: full api_key values NEVER leave the DB on this page render.
    We compute a 'first 6 + last 4' preview in SQL so the response bytes
    contain only the masked version. If you need to copy-paste the original
    key into another tool, re-add it from the source (CF dashboard) — that
    flow is one-time and intentional.
    """
    from modules.cf_key_pool import list_cf_keys
    from database import get_db
    cf_keys = list_cf_keys()
    if cf_keys:
        conn = get_db()
        try:
            previews = {r["id"]: r["preview"] for r in conn.execute(
                """SELECT id,
                          substr(api_key, 1, 6) || '...' ||
                          substr(api_key, length(api_key) - 3) AS preview
                     FROM cf_keys"""
            ).fetchall()}
        finally:
            conn.close()
        for k in cf_keys:
            k["key_preview"] = previews.get(k["id"], "")
    return render_template("cloudflare.html", cf_keys=cf_keys)


@app.route("/api/cf-keys/<int:key_id>/edit", methods=["POST"])
@login_required
def api_cf_keys_edit(key_id):
    """Edit a CF key's alias or max_domains. Cannot edit email / api_key
    (re-add a fresh key for that — preserves the 'verify on add' flow)."""
    from database import get_db
    alias = (request.form.get("alias") or "").strip() or None
    try:
        max_domains = int(request.form.get("max_domains") or 0)
    except ValueError:
        flash("max_domains must be an integer", "warning")
        return redirect(url_for("cloudflare_page"))
    if max_domains < 1 or max_domains > 1000:
        flash("max_domains must be between 1 and 1000", "warning")
        return redirect(url_for("cloudflare_page"))

    conn = get_db()
    try:
        cur = conn.execute(
            "UPDATE cf_keys SET alias=?, max_domains=? WHERE id=?",
            (alias, max_domains, key_id)
        )
        conn.commit()
        if cur.rowcount:
            flash(f"CF key #{key_id} updated", "success")
        else:
            flash("Key not found", "warning")
    finally:
        conn.close()
    return redirect(url_for("cloudflare_page"))


@app.route("/api/cf-keys/<int:key_id>/delete", methods=["POST"])
@login_required
def api_cf_keys_delete(key_id):
    """Remove a CF key from the pool (only if no domain references it)."""
    from database import get_db
    conn = get_db()
    try:
        ref = conn.execute(
            "SELECT COUNT(*) FROM domains WHERE cf_key_id=?", (key_id,)
        ).fetchone()[0]
        if ref:
            flash(f"Cannot delete — {ref} domain(s) still reference this key", "warning")
        else:
            conn.execute("DELETE FROM cf_keys WHERE id=?", (key_id,))
            conn.commit()
            flash(f"CF key #{key_id} removed from pool", "success")
    finally:
        conn.close()
    return redirect(url_for("cloudflare_page"))


# ========================= LLM KEY TEST =========================

@app.route("/api/settings/telegram-detect-chat", methods=["POST"])
@login_required
def api_telegram_detect_chat():
    """Given a Telegram bot token, call getUpdates and return every unique
    chat the bot has received a message from. Lets the user click one entry
    to auto-fill telegram_chat_id without visiting api.telegram.org manually.
    """
    import requests as _rq
    token = (request.form.get("telegram_bot_token") or
             get_setting("telegram_bot_token") or "").strip()
    if not token:
        return jsonify({"ok": False,
                        "error": "No bot token provided. Paste the token "
                                 "from @BotFather first, then click detect."})
    try:
        r = _rq.get(f"https://api.telegram.org/bot{token}/getUpdates",
                    timeout=15)
        if not r.ok:
            return jsonify({"ok": False,
                            "error": f"HTTP {r.status_code}: {r.text[:200]}"})
        data = r.json()
        if not data.get("ok"):
            return jsonify({"ok": False,
                            "error": f"Telegram API: {data.get('description','rejected')}"})

        # Dedupe by chat.id, keep the most useful metadata
        chats = {}
        for upd in data.get("result", []):
            msg = upd.get("message") or upd.get("edited_message") or {}
            chat = msg.get("chat") or {}
            cid = chat.get("id")
            if not cid:
                continue
            chats[cid] = {
                "id": cid,
                "type": chat.get("type", "?"),
                "title": chat.get("title", ""),
                "username": chat.get("username", ""),
                "first_name": chat.get("first_name", ""),
                "last_name": chat.get("last_name", ""),
            }
        chat_list = list(chats.values())
        # Also fetch bot identity so the UI can tell the user which bot this is
        try:
            me = _rq.get(f"https://api.telegram.org/bot{token}/getMe",
                         timeout=10).json().get("result", {})
        except Exception:
            me = {}
        return jsonify({
            "ok": True,
            "bot": {"username": me.get("username", ""),
                    "name": me.get("first_name", "")},
            "chats": chat_list,
            "hint": ("Message your bot in Telegram first, then click this "
                     "button again — the chat will show up here."
                     if not chat_list else ""),
        })
    except Exception as e:
        return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"})


@app.route("/api/settings/test-notification", methods=["POST"])
@login_required
def api_test_notification():
    """Fire a test alert. `channel=email|telegram|whatsapp|sms|all`.
    Ignores the master `notifications_enabled` switch so a test always
    sends even while notifications are paused globally.
    """
    from modules import notify as notify_mod
    channel = (request.form.get("channel") or "all").strip().lower()
    # Temporarily flip the master switch ON for the duration of this call
    prev = get_setting("notifications_enabled")
    set_setting("notifications_enabled", "1")
    try:
        if channel == "all":
            chans = None
        elif channel in notify_mod._CHANNELS:
            chans = [channel]
        else:
            return jsonify({"ok": False,
                            "error": f"unknown channel: {channel}"}), 400
        result = notify_mod.notify(
            subject=f"Test alert ({channel})",
            body=("This is a test from your SSR dashboard. "
                  "If you see this, the channel is working."),
            severity="info", channels=chans, blocking=True,
        )
    finally:
        set_setting("notifications_enabled", prev or "0")
    return jsonify({"ok": True, "result": result,
                    "status": notify_mod.notify_status()})


@app.route("/api/settings/test-do-keys", methods=["POST"])
@login_required
def api_test_do_keys():
    """Ping /account with both DO tokens. If form provides `do_api_token` /
    `do_api_token_backup`, test THOSE (current form values) — so users can
    verify a pasted token without clicking Save first. Falls back to stored
    DB values when no form data is provided (e.g., from a cURL probe).
    """
    from modules import digitalocean as do
    import requests as _rq

    # Prefer form-provided values; fall back to stored settings
    primary = (request.form.get("do_api_token") or "").strip() \
              or (get_setting("do_api_token") or "").strip()
    backup  = (request.form.get("do_api_token_backup") or "").strip() \
              or (get_setting("do_api_token_backup") or "").strip()

    def probe(tok: str) -> dict:
        if not tok:
            return {"configured": False, "ok": False,
                    "email": "", "error": "not provided"}
        try:
            r = _rq.get("https://api.digitalocean.com/v2/account",
                        headers={"Authorization": f"Bearer {tok}"}, timeout=15)
            if r.ok:
                d = r.json().get("account", {})
                return {"configured": True, "ok": True,
                        "email": d.get("email", "?"),
                        "status": d.get("status", "?"),
                        "droplet_limit": d.get("droplet_limit"),
                        "error": ""}
            return {"configured": True, "ok": False,
                    "email": "", "error": f"HTTP {r.status_code}: {r.text[:140]}"}
        except Exception as e:
            return {"configured": True, "ok": False,
                    "email": "", "error": f"{type(e).__name__}: {e}"}

    return jsonify({"primary": probe(primary), "backup": probe(backup)})


@app.route("/api/settings/test-llm-key", methods=["POST"])
@login_required
def api_test_llm_key():
    """Validate an API key for one of the supported LLM providers.

    Accepts form params:
      provider    — one of: anthropic, openai, gemini, openrouter
      llm_api_key — the key to test (optional; falls back to the saved per-provider key)

    Each provider is tested via a cheap endpoint that requires auth but
    incurs minimal or zero cost (list models / 1-token chat call).
    """
    import requests as _rq

    provider = (request.form.get("provider") or
                get_setting("llm_provider") or "anthropic").strip().lower()
    key = ((request.form.get("llm_api_key") or "").strip()
           or (get_setting(f"llm_api_key_{provider}") or "").strip()
           or (get_setting("llm_api_key") or "").strip())
    if not key:
        return jsonify({"ok": False, "error": "No API key provided"}), 400

    try:
        if provider == "anthropic":
            r = _rq.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": get_setting("llm_model") or "claude-haiku-4-5-20251001",
                      "max_tokens": 1,
                      "messages": [{"role": "user", "content": "hi"}]},
                timeout=20,
            )
            if r.status_code == 200:
                data = r.json() or {}
                return jsonify({"ok": True, "provider": provider,
                                "model": data.get("model"),
                                "usage": data.get("usage", {})})
            return jsonify({"ok": False, "provider": provider,
                            "status": r.status_code, "error": r.text[:300]})

        if provider == "openai":
            r = _rq.get("https://api.openai.com/v1/models",
                        headers={"Authorization": f"Bearer {key}"}, timeout=15)
            if r.status_code == 200:
                count = len((r.json() or {}).get("data", []))
                return jsonify({"ok": True, "provider": provider,
                                "info": f"{count} models accessible"})
            return jsonify({"ok": False, "provider": provider,
                            "status": r.status_code, "error": r.text[:300]})

        if provider == "openrouter":
            r = _rq.get("https://openrouter.ai/api/v1/auth/key",
                        headers={"Authorization": f"Bearer {key}"}, timeout=15)
            if r.status_code == 200:
                data = (r.json() or {}).get("data", {}) or {}
                return jsonify({"ok": True, "provider": provider,
                                "label": data.get("label") or "key",
                                "credit_used": data.get("usage"),
                                "limit": data.get("limit")})
            return jsonify({"ok": False, "provider": provider,
                            "status": r.status_code, "error": r.text[:300]})

        if provider == "gemini":
            r = _rq.get("https://generativelanguage.googleapis.com/v1beta/models",
                        headers={"x-goog-api-key": key}, timeout=15)
            if r.status_code == 200:
                count = len((r.json() or {}).get("models", []))
                return jsonify({"ok": True, "provider": provider,
                                "info": f"{count} models accessible"})
            return jsonify({"ok": False, "provider": provider,
                            "status": r.status_code, "error": r.text[:300]})

        return jsonify({"ok": False, "error": f"unsupported provider: {provider}"}), 400

    except Exception as e:
        return jsonify({"ok": False, "provider": provider, "error": str(e)}), 200


@app.route("/api/domains/export")
@login_required
def api_export_csv():
    import csv, io
    from flask import Response
    domains = get_domains()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["domain", "status", "cf_email", "cf_zone_id",
                     "cf_nameservers", "current_proxy_ip", "server_id", "created_at"])
    for d in domains:
        writer.writerow([d["domain"], d["status"], d["cf_email"] or "",
                         d["cf_zone_id"] or "", d["cf_nameservers"] or "",
                         d["current_proxy_ip"] or "", d["server_id"] or "", d["created_at"]])
    output.seek(0)
    return Response(output.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=ssr_domains.csv"})


@app.route("/api/domains/import", methods=["POST"])
@login_required
def api_import_csv():
    import csv, io
    file = request.files.get("csv_file")
    if not file:
        flash("No file uploaded", "danger")
        return redirect(url_for("domains_page"))
    content = file.read().decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(content))
    count = 0
    for row in reader:
        domain = row.get("domain", "").strip()
        if domain:
            add_domain(domain)
            updates = {}
            for key in ["cf_email", "cf_global_key", "cf_zone_id", "cf_nameservers"]:
                if row.get(key, "").strip():
                    updates[key] = row[key].strip()
            if updates:
                update_domain(domain, **updates)
            count += 1
    flash(f"Imported {count} domain(s) from CSV", "success")
    return redirect(url_for("domains_page"))


def _validate_domain(d):
    import re
    d = d.strip().lower()
    if not d or len(d) > 253:
        return None
    if not re.match(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$', d):
        return None
    return d


@app.route("/api/domains", methods=["POST"])
@login_required
def api_add_domains():
    raw = request.form.get("domains", "") or (request.json or {}).get("domains", "")
    raw_list = [d.strip() for d in raw.replace(",", "\n").split("\n") if d.strip()]
    domains_list = [_validate_domain(d) for d in raw_list]
    domains_list = [d for d in domains_list if d]
    skipped = len(raw_list) - len(domains_list)
    for d in domains_list:
        add_domain(d)
    msg = f"Added {len(domains_list)} domain(s)"
    if skipped:
        msg += f" ({skipped} invalid skipped)"
    flash(msg, "success")
    if request.is_json:
        return jsonify({"ok": True, "count": len(domains_list)})
    return redirect(url_for("domains_page"))


@app.route("/api/domains/<domain>/delete", methods=["POST"])
@login_required
def api_delete_domain(domain):
    from modules.cf_key_pool import release_cf_key_slot
    # Release the CF key slot BEFORE deleting the domain row — release_cf_key_slot
    # reads cf_key_id from the domains row, so once the row is gone the slot
    # leaks and cf_keys.domains_used drifts up forever.
    release_cf_key_slot(domain)
    delete_domain(domain)
    flash(f"Deleted {domain} from dashboard", "info")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/<domain>/full-delete", methods=["POST"])
@login_required
def api_full_delete_domain(domain):
    from modules.jobs import enqueue_job
    enqueue_job("domain.teardown", {"domain": domain})
    audit("domain_full_delete", target=domain, actor_ip=request.remote_addr or "")
    flash(f"Full deletion started for {domain} (SA + CF + Spaceship + DB)", "warning")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/bulk-delete", methods=["POST"])
@login_required
def api_bulk_delete():
    domain_ids = request.form.getlist("domain_ids")
    delete_from = request.form.get("delete_from", "all")

    domains_list = []
    for d in get_domains():
        if str(d["id"]) in domain_ids:
            domains_list.append(d["domain"])

    if not domains_list:
        flash("No domains selected", "warning")
        return redirect(url_for("domains_page"))

    if delete_from == "db_only":
        from modules.cf_key_pool import release_cf_key_slot
        for domain in domains_list:
            release_cf_key_slot(domain)
            delete_domain(domain)
        flash(f"Deleted {len(domains_list)} domain(s) from dashboard", "info")
    else:
        from modules.jobs import enqueue_job
        enqueue_job("domain.bulk_teardown", {"domains": domains_list})
        flash(f"Full deletion started for {len(domains_list)} domain(s)", "warning")

    return redirect(url_for("domains_page"))


def _teardown_domain(domain):
    from modules.cloudflare_api import delete_zone
    from modules.serveravatar import delete_application
    from modules.spaceship import delete_domain as spaceship_delete
    from modules.cf_key_pool import release_cf_key_slot
    from modules.migration import delete_archive
    from modules.pipeline import (
        HeartbeatTicker, _try_acquire_slot, _release_slot,
    )
    from database import get_db as _get_db

    d = get_domain(domain)
    if not d:
        return

    # R6: take the same per-domain slot the pipeline/migration use so the
    # teardown can't race a mid-flight pipeline or migration on this domain.
    # If someone else has it, wait briefly + try once more (they'll finish soon).
    if not _try_acquire_slot(domain):
        log_pipeline(domain, "teardown", "warning",
                     "Another worker is busy with this domain — waiting 5s then retrying once")
        time.sleep(5)
        if not _try_acquire_slot(domain):
            log_pipeline(domain, "teardown", "failed",
                         "Teardown aborted — another worker still holds the slot. "
                         "Try again in a minute.")
            return

    try:
        # Pulse heartbeat(domain) every 1s so the watcher UI can prove the
        # teardown worker is still alive during slow external API calls (SA,
        # CF, Spaceship delete can each take 5–15s).
        with HeartbeatTicker(domain, interval=1.0):
            housed_server_id = d["server_id"]

            if housed_server_id:
                for s in get_servers():
                    if s["id"] == housed_server_id and s["sa_server_id"]:
                        try:
                            delete_application(s["sa_server_id"], domain)
                        except Exception as e:
                            log_pipeline(domain, "teardown", "warning", f"SA delete: {e}")
                        break

            if d["cf_email"] and d["cf_global_key"]:
                try:
                    delete_zone(domain)
                except Exception as e:
                    log_pipeline(domain, "teardown", "warning", f"CF delete: {e}")

            try:
                spaceship_delete(domain)
            except Exception as e:
                log_pipeline(domain, "teardown", "warning", f"Spaceship delete: {e}")

            # Free the CF-pool slot (20 domains / key accounting) before dropping the row.
            try:
                release_cf_key_slot(domain)
            except Exception as e:
                log_pipeline(domain, "teardown", "warning", f"CF pool release: {e}")

            # Remove the local site archive — avoids orphan files accumulating under
            # data/site_archives/ after a domain is fully deleted.
            try:
                delete_archive(domain)
            except Exception as e:
                log_pipeline(domain, "teardown", "warning", f"Archive delete: {e}")

            delete_domain(domain)

        log_pipeline(domain, "teardown", "completed",
                     f"{domain} fully removed (SA+CF+Spaceship+DB+pool slot freed)")
    finally:
        _release_slot(domain)


def _bulk_teardown(domains_list):
    for domain in domains_list:
        _teardown_domain(domain)


@app.route("/api/domains/<domain>/cancel-pipeline", methods=["POST"])
@login_required
def api_cancel_pipeline(domain):
    """Signal the pipeline worker to stop at the next step boundary.
    The worker can't be interrupted mid-API-call, but between steps it
    checks cancel_requested and raises PipelineCanceled cleanly."""
    from modules.pipeline import is_pipeline_running
    if not is_pipeline_running(domain):
        flash(f"No pipeline running for {domain}", "info")
        return redirect(url_for("domains_page"))
    update_domain(domain, cancel_requested=1)
    audit("pipeline_cancel", target=domain, actor_ip=request.remote_addr or "")
    flash(f"Cancel requested for {domain} — will stop at next step boundary",
          "warning")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/<domain>/runs")
@login_required
def api_domain_runs(domain):
    """Recent pipeline_runs for a domain (history list, no step details).
    Returns 404 if the domain isn't in our DB so a probe can't enumerate
    valid vs. invalid domain names.
    """
    from database import list_pipeline_runs
    if not get_domain(domain):
        return jsonify({"error": "Domain not found"}), 404
    runs = list_pipeline_runs(domain, limit=int(request.args.get("limit", "20")))
    return jsonify({"runs": runs})


@app.route("/api/runs/<int:run_id>")
@login_required
def api_run_detail(run_id):
    """Full detail for a single run: the run row + its step_runs (status,
    timing, message, artifact_json) ordered by step_num."""
    from database import get_pipeline_run, get_step_runs
    run = get_pipeline_run(run_id)
    if not run:
        return jsonify({"error": "Run not found"}), 404
    return jsonify({"run": run, "steps": get_step_runs(run_id)})


@app.route("/api/domains/<domain>/run-from/<int:step_num>", methods=["POST"])
@login_required
def api_run_from_step(domain, step_num):
    """Kick off a pipeline starting at `step_num`. Used by the history-modal
    'Retry from here' / 'Continue from here' buttons. 'Skip this step' is
    just /run-from/<N+1> — the same endpoint with the next number.

    No body required — pulls the previously-stored server_id (if any) from
    the domain row via the existing start_from-> 6 safety logic. POST without
    a CSRF body still requires Origin/Referer per _security_middleware.

    Refuses unknown domains (404 equivalent flash) so a stray POST can't
    silently insert a phantom row via the pipeline's add_domain() call.
    """
    if step_num < 1 or step_num > 10:
        flash("step_num must be between 1 and 10", "warning")
        return redirect(url_for("domains_page"))
    if not get_domain(domain):
        flash(f"Unknown domain '{domain}' — add it first", "warning")
        return redirect(url_for("domains_page"))
    skip_purchase = request.form.get("skip_purchase") == "on"
    job_id = run_full_pipeline(domain, skip_purchase=skip_purchase,
                                start_from=step_num)
    if job_id is None:
        flash(f"Pipeline for {domain} already running — request ignored",
              "warning")
    else:
        audit("pipeline_run_from",
              target=domain, actor_ip=request.remote_addr or "",
              detail=f"start_from={step_num}")
        flash(f"Pipeline started for {domain} from step {step_num}", "success")
    return redirect(url_for("domains_page"))


# Whitelist of domain columns that operators can override via the step
# console, plus per-field byte caps. Anything not in this dict is rejected
# — prevents accidental writes to server_id (would mis-route subsequent
# runs), cf_key_id (would corrupt slot accounting), audit IDs, etc.
#
# Caps prevent a single bad paste from bloating sqlite + stalling writes.
# 1 MiB for HTML/PHP, 16 KiB for cert/key PEMs, 1 KiB for everything else.
_OVERRIDABLE_DOMAIN_COLS = {
    "site_html":         1 * 1024 * 1024,    # step 9 output: paste your own PHP
    "status":            64,                 # any step: nudge the state machine
    "cf_zone_id":        128,                # step 3 output: bring-your-own zone
    "cf_nameservers":    1024,               # step 3 output: brought-your-own NS
    "cf_email":          255,                # step 2 manual override
    "cf_global_key":     1024,               # step 2 manual override
    "current_proxy_ip":  64,                 # step 7 output
    "origin_cert_pem":   16 * 1024,          # step 8 BYO cert (typical PEM ~2KB)
    "origin_key_pem":    16 * 1024,          # step 8 BYO key
}


@app.route("/api/domains/<domain>/override-field", methods=["POST"])
@login_required
def api_override_field(domain):
    """Override one whitelisted domain column with a manual value. Used by
    the step console's 'Override' button when an automated step keeps
    failing or you want to substitute your own value (e.g., paste hand-written
    PHP for step 9 instead of letting the LLM regenerate).
    """
    field = (request.form.get("field") or "").strip()
    value = request.form.get("value", "")
    if field not in _OVERRIDABLE_DOMAIN_COLS:
        flash(f"Field '{field}' not overridable. Allowed: "
              + ", ".join(sorted(_OVERRIDABLE_DOMAIN_COLS)),
              "danger")
        return redirect(url_for("domains_page"))
    cap = _OVERRIDABLE_DOMAIN_COLS[field]
    if len(value.encode("utf-8")) > cap:
        flash(
            f"Value too large for {field}: "
            f"{len(value.encode('utf-8'))} bytes > {cap}-byte cap. "
            "Nothing was written.",
            "danger",
        )
        return redirect(url_for("domains_page"))
    prev = get_domain(domain)
    prev_len = len((prev[field] if prev and field in prev.keys() else "") or "")
    update_domain(domain, **{field: value})
    audit("domain_override",
          target=domain, actor_ip=request.remote_addr or "",
          detail=f"field={field} old_len={prev_len} new_len={len(value)}")
    flash(f"Override saved: {domain}.{field} "
          f"(prev={prev_len} chars, new={len(value)} chars)", "success")
    return redirect(url_for("domains_page"))


@app.route("/api/preflight/<domain>")
@login_required
def api_preflight(domain):
    """Run preflight checks for the given domain. Returns JSON aggregate.
    Domain is currently unused by the checks (they're all global) but is in
    the URL for future per-domain state checks (e.g., cf_zone_id present)
    without changing the route shape."""
    from modules import preflight
    skip_purchase = request.args.get("skip_purchase") == "on"
    return jsonify(preflight.run_all(skip_purchase=skip_purchase))


@app.route("/api/domains/<domain>/run-pipeline", methods=["POST"])
@login_required
def api_run_pipeline(domain):
    if not get_domain(domain):
        flash(f"Unknown domain '{domain}' — add it first", "warning")
        return redirect(url_for("domains_page"))
    skip_purchase = request.form.get("skip_purchase") == "on"
    server_id = request.form.get("server_id")
    start_from = request.form.get("start_from")
    server_id = int(server_id) if server_id else None
    start_from = int(start_from) if start_from else None
    thread = run_full_pipeline(domain, skip_purchase=skip_purchase,
                               server_id=server_id, start_from=start_from)
    if thread is None:
        flash(f"Pipeline for {domain} already running — request ignored", "warning")
    else:
        flash(f"Pipeline started for {domain}", "success")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/run-bulk", methods=["POST"])
@login_required
def api_run_bulk():
    domain_ids = request.form.getlist("domain_ids")
    skip_purchase = request.form.get("skip_purchase") == "on"
    server_id = request.form.get("server_id")
    server_id = int(server_id) if server_id else None

    domains_list = []
    for d in get_domains():
        if str(d["id"]) in domain_ids:
            domains_list.append(d["domain"])

    if domains_list:
        run_bulk_pipeline(domains_list, skip_purchase=skip_purchase,
                          server_id=server_id)
        flash(f"Bulk pipeline started for {len(domains_list)} domains", "success")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/<domain>/update-cf", methods=["POST"])
@login_required
def api_update_cf(domain):
    cf_email = request.form.get("cf_email", "").strip()
    cf_global_key = request.form.get("cf_global_key", "").strip()
    cf_zone_id = request.form.get("cf_zone_id", "").strip()
    updates = {}
    if cf_email:
        updates["cf_email"] = cf_email
    if cf_global_key:
        updates["cf_global_key"] = cf_global_key
    if cf_zone_id:
        updates["cf_zone_id"] = cf_zone_id
    if updates:
        update_domain(domain, **updates)
        flash(f"Updated CF credentials for {domain}", "success")
    return redirect(url_for("domains_page"))


# ========================= SERVERS =========================

@app.route("/servers")
@login_required
def servers_page():
    servers = get_servers()
    return render_template("servers.html", servers=servers)


def _server_create_handler(payload):
    """Job handler for kind='server.create'. Same body the api_create_server
    endpoint used to run inline as a daemon thread, lifted to module scope
    so the durable job worker can dispatch it after a restart.
    """
    name = payload["name"]
    region = payload.get("region", "nyc1")
    size = payload.get("size", "s-1vcpu-1gb")

    from modules.digitalocean import create_droplet
    from modules.serveravatar import get_server_info
    import time, paramiko, requests

    try:
        server_id, ip, droplet_id = create_droplet(name, region=region, size=size)
        log_pipeline(name, "server_create", "running", f"Droplet ready: {ip}. Waiting 30s...")
        time.sleep(30)

        root_pass = get_setting("server_root_password") or "SsrServer@2024"
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            key_path = os.path.join(os.path.dirname(__file__), "data", "ssr_key")
            if os.path.exists(key_path):
                ssh.connect(ip, username="root", key_filename=key_path, timeout=30)
            else:
                ssh.connect(ip, username="root", password=root_pass, timeout=30)
            ssh.exec_command(f"echo 'root:{root_pass}' | chpasswd")
            ssh.exec_command(
                "sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/g' "
                "/etc/ssh/sshd_config.d/*.conf 2>/dev/null; "
                "sed -i 's/#PasswordAuthentication/PasswordAuthentication/g' "
                "/etc/ssh/sshd_config; systemctl restart ssh"
            )
            ssh.close()
            log_pipeline(name, "server_create", "running", "SSH password enabled")
        except Exception as e:
            log_pipeline(name, "server_create", "warning", f"SSH setup: {e}")

        sa_token = get_setting("serveravatar_api_key") or ""
        sa_org = get_setting("serveravatar_org_id") or ""
        resp = requests.post(
            f"https://api.serveravatar.com/organizations/{sa_org}/direct-installation/generate-command",
            headers={"Authorization": sa_token, "Content-Type": "application/json",
                     "Accept": "application/json"},
            json={"name": name, "ip": ip, "ssh_port": 22,
                  "root_password_available": True, "root_password": root_pass,
                  "web_server": "apache2", "database_type": "mysql", "nodejs": False},
            timeout=120
        )
        resp.raise_for_status()
        sa_data = resp.json()
        sa_server_id = str(sa_data.get("server", {}).get("id", ""))
        update_server(server_id, sa_server_id=sa_server_id, sa_org_id=sa_org)
        log_pipeline(name, "server_create", "running",
                     f"SA agent installing (ID: {sa_server_id})...")

        deadline = time.time() + 600
        while time.time() < deadline:
            try:
                info = get_server_info(sa_server_id)
                agent = str(info.get("agent_status", ""))
                if agent in ("1", "connected", "active"):
                    update_server(server_id, status="ready")
                    log_pipeline(name, "server_create", "completed",
                                 f"Server READY: {ip} (SA: {sa_server_id})")
                    return
                log_pipeline(name, "sa_install", "running", f"Agent status: {agent}")
            except Exception:
                pass
            time.sleep(20)

        update_server(server_id, status="ready")
        log_pipeline(name, "server_create", "warning",
                     "SA agent install timeout — marked ready anyway")

    except Exception as e:
        log_pipeline(name, "server_create", "failed", str(e))


@app.route("/api/servers/create", methods=["POST"])
@login_required
def api_create_server():
    name = request.form.get("name", "ssr-server").strip()
    region = request.form.get("region", "nyc1").strip()
    size = request.form.get("size", "s-1vcpu-1gb").strip()

    from modules.jobs import enqueue_job
    enqueue_job("server.create", {"name": name, "region": region, "size": size})
    flash(f"Server creation started: {name}", "success")
    return redirect(url_for("servers_page"))


@app.route("/api/servers/sync-from-do", methods=["POST"])
@login_required
def api_servers_sync_from_do():
    """Reverse of import-from-do: drop dashboard rows whose DO droplet has
    been destroyed upstream. Only touches rows with do_droplet_id set —
    manually-added servers without a DO droplet id are left alone.
    Refuses to remove rows that still have domains referencing them, so a
    sync after an upstream destruction won't cascade-orphan their domains.
    """
    from modules.digitalocean import list_droplets
    from database import get_db
    try:
        live = {int(d["id"]) for d in list_droplets()}
    except Exception as e:
        flash(f"DO list failed: {e}", "warning")
        return redirect(url_for("servers_page"))

    conn = get_db()
    removed, blocked, kept = [], [], 0
    try:
        rows = conn.execute(
            "SELECT id, name, ip, do_droplet_id FROM servers WHERE do_droplet_id IS NOT NULL"
        ).fetchall()
        for r in rows:
            if int(r["do_droplet_id"]) in live:
                kept += 1
                continue
            ref = conn.execute(
                "SELECT COUNT(*) FROM domains WHERE server_id=?", (r["id"],)
            ).fetchone()[0]
            if ref:
                blocked.append(f"{r['name']} ({ref} domain(s))")
                continue
            conn.execute("DELETE FROM servers WHERE id=?", (r["id"],))
            removed.append(r["name"] or f"srv-{r['id']}")
        conn.commit()
    finally:
        conn.close()

    audit("servers_sync_from_do",
          actor_ip=request.remote_addr or "",
          detail=f"removed={len(removed)} kept={kept} blocked={len(blocked)}")
    msg = f"Sync done — removed {len(removed)}, kept {kept}"
    if blocked:
        msg += f". Blocked (still referenced): {', '.join(blocked)}"
    flash(msg, "info" if removed or not blocked else "warning")
    return redirect(url_for("servers_page"))


@app.route("/api/servers/import-from-do", methods=["POST"])
@login_required
def api_import_from_do():
    """Pull every droplet the DO API returns and add DB rows for anything
    we don't already know about. Does NOT install SA — user has to do that
    manually (via the SA dashboard or by running `install_agent_on_droplet`
    later). Newly imported rows get status='detected' and no sa_server_id
    so the pipeline treats them as unready until SA is wired up.
    """
    from modules.digitalocean import list_droplets, DOAllTokensFailed
    from database import get_db as _get_db

    try:
        # No tag filter — pull ALL droplets so user can see their whole fleet
        do_droplets = list_droplets(tag=None)
    except DOAllTokensFailed as e:
        flash(f"DO API rejected both tokens: {e}", "danger")
        return redirect(url_for("servers_page"))
    except Exception as e:
        flash(f"DO API error: {e}", "danger")
        return redirect(url_for("servers_page"))

    existing_droplet_ids = {str(s["do_droplet_id"]) for s in get_servers()
                            if s.get("do_droplet_id")}
    existing_ips = {s["ip"] for s in get_servers() if s.get("ip")}

    added = 0
    skipped_existing = 0
    for d in do_droplets:
        droplet_id = str(d.get("id", ""))
        name = d.get("name", f"droplet-{droplet_id}")
        # Find the public IPv4
        ip = ""
        for net in d.get("networks", {}).get("v4", []):
            if net.get("type") == "public":
                ip = net["ip_address"]
                break
        if not ip:
            continue
        if droplet_id in existing_droplet_ids or ip in existing_ips:
            skipped_existing += 1
            continue

        sid = add_server(name, ip, droplet_id)
        # Update with region + size_slug from DO for display
        conn = _get_db()
        try:
            conn.execute(
                "UPDATE servers SET status=?, region=?, size_slug=? WHERE id=?",
                ("detected", d.get("region", {}).get("slug", ""),
                 d.get("size_slug", ""), sid),
            )
            conn.commit()
        finally:
            conn.close()
        added += 1

    audit("import_from_do", actor_ip=request.remote_addr or "",
          detail=f"added={added} skipped={skipped_existing}")

    if added:
        flash(f"Imported {added} droplet(s) from DigitalOcean. "
              f"Each row has status='detected' — click through to wire up "
              f"ServerAvatar agent before running pipelines on them.",
              "success")
    else:
        flash(f"No new droplets to import (already had {skipped_existing} "
              f"of {len(do_droplets)} DO droplet(s)).", "info")
    return redirect(url_for("servers_page"))


@app.route("/api/domains/sync-from-sa", methods=["POST"])
@login_required
def api_domains_sync_from_sa():
    """Reverse of import-from-sa: drop domain rows that no longer have a
    matching SA application. Only touches domains that previously WERE
    hosted (status in {app_created, ssl_installed, hosted, live}) and
    that reference a known server. Domains in earlier states (pending,
    detected, cf_assigned, etc.) are skipped — they were never on SA.

    Releases the CF key slot before removing each row so cf_keys.domains_used
    stays accurate (same flow as the manual soft-delete).
    """
    from modules import serveravatar
    from modules.cf_key_pool import release_cf_key_slot
    from database import get_db, delete_domain

    HOSTED_STATES = ("app_created", "ssl_installed", "hosted", "live")

    conn = get_db()
    server_ids_to_check = set()
    try:
        rows = conn.execute(
            "SELECT id, sa_server_id FROM servers WHERE sa_server_id IS NOT NULL AND status='ready'"
        ).fetchall()
        for r in rows:
            server_ids_to_check.add((r["id"], r["sa_server_id"]))
    finally:
        conn.close()

    # Build the set of (db_server_id, domain_name) pairs that exist on SA.
    # If a single server's API call fails (rate limit, network blip, stale
    # sa_server_id), keep going with the others — one bad server should NOT
    # block cleanup for the rest of the fleet. Only domains whose server
    # was successfully queried are eligible for orphan removal; domains
    # on failed servers are intentionally skipped (we can't tell whether
    # their SA app exists or not, so leaving them alone is the safe default).
    live_pairs = set()
    queried_server_ids = set()
    failed_servers = []
    for db_id, sa_id in server_ids_to_check:
        try:
            apps = serveravatar.list_applications(sa_id)
            queried_server_ids.add(db_id)
            for a in apps:
                name = (a.get("name") or a.get("primary_domain") or "").lower().strip()
                if name:
                    live_pairs.add((db_id, name))
        except Exception as e:
            failed_servers.append(f"sa_id={sa_id}: {type(e).__name__}: {e}")

    conn = get_db()
    removed = []
    skipped_unqueryable = []
    try:
        rows = conn.execute(
            f"SELECT domain, server_id, status FROM domains "
            f"WHERE status IN ({','.join('?' * len(HOSTED_STATES))}) "
            f"AND server_id IS NOT NULL",
            HOSTED_STATES
        ).fetchall()
        for r in rows:
            if r["server_id"] not in queried_server_ids:
                # We couldn't query this server's SA app list, so we don't
                # know whether the domain still has an app or not. Skip
                # rather than risk false-positive removal.
                skipped_unqueryable.append(r["domain"])
                continue
            pair = (r["server_id"], r["domain"].lower())
            if pair in live_pairs:
                continue
            removed.append(r["domain"])
    finally:
        conn.close()

    for d in removed:
        try: release_cf_key_slot(d)
        except Exception: pass
        delete_domain(d)

    audit("domains_sync_from_sa",
          actor_ip=request.remote_addr or "",
          detail=(f"removed={len(removed)} "
                   f"skipped_unqueryable={len(skipped_unqueryable)} "
                   f"failed_servers={len(failed_servers)}"))
    parts = [f"Sync done — removed {len(removed)} domain(s) no longer on SA"]
    if removed:
        parts.append(
            f"({', '.join(removed[:3])}{'...' if len(removed) > 3 else ''})"
        )
    if skipped_unqueryable:
        parts.append(
            f"; skipped {len(skipped_unqueryable)} on unreachable servers"
        )
    if failed_servers:
        parts.append(
            f"; SA list failed for: {'; '.join(failed_servers[:3])}"
        )
    flash(" ".join(parts),
          "warning" if (failed_servers or skipped_unqueryable) else "info")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/import-from-sa", methods=["POST"])
@login_required
def api_import_from_sa():
    """Import only the domains that are actually hosted on your ServerAvatar
    servers — NOT all 1600+ Spaceship-registered domains.

    Flow:
      1. list every SA server in the org
      2. for each, list its applications
      3. for each app's primary_domain, add a row linked to THIS dashboard's
         server_id (matched by sa_server_id) with status='hosted'

    Also ensures each SA server has a row in our `servers` table, so linking
    works cleanly even if the server wasn't imported via `/api/servers/import-from-do`
    first.
    """
    from modules import serveravatar

    # 1. SA servers
    try:
        sa_servers = serveravatar.list_servers()
    except Exception as e:
        flash(f"ServerAvatar API error listing servers: {e}", "danger")
        return redirect(url_for("domains_page"))

    # Build an {sa_server_id: our_dashboard_server_id} map, creating rows for
    # any SA server we don't already track.
    from database import get_db as _get_db
    existing = {str(s["sa_server_id"]): s["id"] for s in get_servers()
                if s.get("sa_server_id")}
    sa_to_our = {}
    new_servers = 0
    for sa in sa_servers:
        sa_id = str(sa.get("id", ""))
        if not sa_id:
            continue
        if sa_id in existing:
            sa_to_our[sa_id] = existing[sa_id]
            continue
        # Add a DB row so imported apps can link to it
        name = sa.get("name") or f"sa-srv-{sa_id}"
        ip = sa.get("ip") or ""
        our_id = add_server(name, ip, None)  # do_droplet_id unknown for SA-only rows
        conn = _get_db()
        try:
            conn.execute(
                "UPDATE servers SET sa_server_id=?, status='ready' WHERE id=?",
                (sa_id, our_id))
            conn.commit()
        finally:
            conn.close()
        sa_to_our[sa_id] = our_id
        new_servers += 1

    # 2. pull every app on every SA server
    existing_domains = {d["domain"] for d in get_domains()}
    added = 0
    skipped_existing = 0
    errors = 0
    total_apps = 0
    for sa in sa_servers:
        sa_id = str(sa.get("id", ""))
        try:
            apps = serveravatar.list_applications(sa_id)
        except Exception as e:
            log_pipeline(f"server-{sa_id}", "import_from_sa", "warning",
                         f"list_applications failed: {e}")
            errors += 1
            continue
        total_apps += len(apps)
        our_server_id = sa_to_our.get(sa_id)
        for app_obj in apps:
            # SA stores the primary domain in various fields depending on
            # version. Try them in order.
            name = (app_obj.get("primary_domain")
                    or app_obj.get("name")
                    or app_obj.get("url") or "").strip().lower()
            # Strip any http(s):// prefix or trailing paths
            name = name.replace("https://", "").replace("http://", "")
            name = name.split("/")[0].strip()
            if not name or "." not in name:
                continue
            if name in existing_domains:
                skipped_existing += 1
                continue
            add_domain(name)
            # Link to its SA server + mark as already-hosted
            update_domain(name, server_id=our_server_id, status="hosted")
            existing_domains.add(name)
            added += 1

    audit("import_from_sa", actor_ip=request.remote_addr or "",
          detail=f"added={added} new_servers={new_servers} "
                 f"apps_seen={total_apps} skipped={skipped_existing} errors={errors}")

    parts = [f"Imported {added} hosted domain(s) from ServerAvatar"]
    if new_servers:
        parts.append(f"+ {new_servers} new server row(s)")
    if skipped_existing:
        parts.append(f"{skipped_existing} already tracked")
    if errors:
        parts.append(f"{errors} SA server(s) failed to list — check logs")
    flash(" · ".join(parts) + ".",
          "success" if added and not errors else "info" if added else "warning")
    return redirect(url_for("domains_page"))


@app.route("/api/servers/add-existing", methods=["POST"])
@login_required
def api_add_existing_server():
    name = request.form.get("name", "").strip()
    ip = request.form.get("ip", "").strip()
    sa_server_id = request.form.get("sa_server_id", "").strip()
    if name and ip:
        sid = add_server(name, ip)
        if sa_server_id:
            update_server(sid, sa_server_id=sa_server_id, status="ready")
        else:
            update_server(sid, status="ready")
        flash(f"Server added: {name} ({ip})", "success")
    return redirect(url_for("servers_page"))


@app.route("/api/servers/<int:server_id>/edit", methods=["POST"])
@login_required
def api_edit_server(server_id):
    """Edit a server's mutable settings: display name + max_sites cap.

    max_sites is the per-server ceiling that step 6 (_find_server) checks
    against the live sites_count when picking a server for a new domain.
    Operators set this to spread load — e.g., 30 domains/server when each
    site is heavy, 100 when they're static. ServerAvatar's apparent ceiling
    is around 200 apps per server in our experience; we cap at 500 to give
    headroom without letting a typo create absurd values.
    """
    from database import get_db

    name = (request.form.get("name") or "").strip()
    try:
        max_sites = int(request.form.get("max_sites") or 0)
    except ValueError:
        flash("max_sites must be an integer", "warning")
        return redirect(url_for("servers_page"))

    if not (1 <= len(name) <= 64):
        flash("name must be 1-64 characters", "warning")
        return redirect(url_for("servers_page"))
    if not (1 <= max_sites <= 500):
        flash("max_sites must be between 1 and 500", "warning")
        return redirect(url_for("servers_page"))

    conn = get_db()
    try:
        row = conn.execute("SELECT name FROM servers WHERE id=?", (server_id,)).fetchone()
        if not row:
            flash("Server not found", "warning")
            return redirect(url_for("servers_page"))
    finally:
        conn.close()

    update_server(server_id, name=name, max_sites=max_sites)
    audit("server_edit", target=str(server_id),
          actor_ip=request.remote_addr or "",
          detail=f"name={name!r} max_sites={max_sites}")
    flash(f"Server #{server_id} updated (name={name}, max_sites={max_sites})",
          "success")
    return redirect(url_for("servers_page"))


@app.route("/api/servers/<int:server_id>/db-delete", methods=["POST"])
@login_required
def api_db_delete_server(server_id):
    """Soft delete: drop the dashboard row only.

    Does NOT touch the DO droplet or the SA server record. Use when the
    droplet has already been destroyed elsewhere, or when you want the
    droplet to keep running but not be tracked here. Domains still
    referencing this server are blocked — clear them first.
    """
    from database import get_db
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM servers WHERE id=?", (server_id,)).fetchone()
        if not row:
            flash("Server not found", "warning")
            return redirect(url_for("servers_page"))

        ref = conn.execute(
            "SELECT COUNT(*) FROM domains WHERE server_id=?", (server_id,)
        ).fetchone()[0]
        if ref:
            flash(
                f"Cannot remove — {ref} domain(s) still reference this server. "
                "Soft-delete or move those domains first.",
                "warning",
            )
            return redirect(url_for("servers_page"))

        conn.execute("DELETE FROM servers WHERE id=?", (server_id,))
        conn.commit()
        audit("server_db_delete", target=str(server_id),
              actor_ip=request.remote_addr or "",
              detail=f"name={row['name']} ip={row['ip']}")
        log_pipeline(row["name"] or f"srv-{server_id}",
                     "server_db_delete", "completed",
                     f"Soft-deleted server #{server_id} (DO droplet untouched)")
        flash(
            f"Server '{row['name']}' removed from dashboard. "
            "DO droplet + SA record still exist.",
            "info",
        )
    finally:
        conn.close()
    return redirect(url_for("servers_page"))


@app.route("/api/servers/<int:server_id>/delete", methods=["POST"])
@login_required
def api_delete_server(server_id):
    """Destroy a server: DO droplet + SA server reference + DB row.

    Safety:
      - Requires a typed-name confirmation (`confirm_name` form field must
        exactly match the server's name in the DB).
      - Refuses if any domain still references this server; user must first
        delete (or move) those domains.

    What happens, in order:
      1. DO: destroy the droplet (stops billing)
      2. SA: delete the server from the ServerAvatar org (cleanup UI)
      3. DB: drop the row
    """
    from database import get_db
    from modules.digitalocean import delete_droplet as do_delete
    import requests as _rq

    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM servers WHERE id=?", (server_id,)).fetchone()
        if not row:
            flash("Server not found", "warning")
            return redirect(url_for("servers_page"))

        confirm = (request.form.get("confirm_name") or "").strip()
        if confirm != (row["name"] or ""):
            flash(
                f"Typed name doesn't match. Got '{confirm}', expected '{row['name']}'. "
                "Nothing was deleted.",
                "danger",
            )
            return redirect(url_for("servers_page"))

        # Block if domains still reference this server
        ref = conn.execute(
            "SELECT COUNT(*) FROM domains WHERE server_id=?", (server_id,)
        ).fetchone()[0]
        if ref:
            flash(
                f"Cannot delete — {ref} domain(s) still hosted on this server. "
                "Delete or move those domains first.",
                "warning",
            )
            return redirect(url_for("servers_page"))

        # 1. Destroy DO droplet (stops billing)
        if row["do_droplet_id"]:
            try:
                do_delete(row["do_droplet_id"])
                log_pipeline(row["name"] or f"srv-{server_id}",
                             "server_teardown", "running",
                             f"DO droplet {row['do_droplet_id']} destroyed")
            except Exception as e:
                # If already deleted (404) don't block the rest
                log_pipeline(row["name"] or f"srv-{server_id}",
                             "server_teardown", "warning",
                             f"DO delete: {e}")

        # 2. Delete SA server record (best-effort)
        sa_id = row["sa_server_id"]
        sa_org = row["sa_org_id"] or get_setting("serveravatar_org_id") or ""
        sa_tok = get_setting("serveravatar_api_key") or ""
        if sa_id and sa_org and sa_tok:
            try:
                r = _rq.delete(
                    f"https://api.serveravatar.com/organizations/{sa_org}/servers/{sa_id}",
                    headers={"Authorization": sa_tok, "Accept": "application/json"},
                    timeout=30,
                )
                if r.status_code >= 400:
                    log_pipeline(row["name"] or f"srv-{server_id}",
                                 "server_teardown", "warning",
                                 f"SA server delete: HTTP {r.status_code} {r.text[:200]}")
                else:
                    log_pipeline(row["name"] or f"srv-{server_id}",
                                 "server_teardown", "running",
                                 f"SA server {sa_id} removed")
            except Exception as e:
                log_pipeline(row["name"] or f"srv-{server_id}",
                             "server_teardown", "warning", f"SA delete: {e}")

        # 3. Drop DB row
        conn.execute("DELETE FROM servers WHERE id=?", (server_id,))
        conn.commit()

        log_pipeline(row["name"] or f"srv-{server_id}",
                     "server_teardown", "completed",
                     f"Server #{server_id} ({row['name']} / {row['ip']}) fully removed")
        audit("server_destroy", target=str(server_id),
              actor_ip=request.remote_addr or "",
              detail=f"name={row['name']} ip={row['ip']}")
        flash(f"Server '{row['name']}' destroyed (droplet + SA + DB)", "warning")
    finally:
        conn.close()

    return redirect(url_for("servers_page"))


@app.route("/api/domains/backfill-origin-certs", methods=["POST"])
@login_required
def api_backfill_origin_certs():
    """One-shot: for every domain with a CF zone but no cached origin_cert_pem,
    re-issue an Origin CA cert from CF and cache it. Runs in a background
    thread — may take minutes if there are many domains. Safe: CF allows
    multiple certs per zone, and the existing cert on each server keeps
    serving traffic.
    """
    import threading
    from modules.cloudflare_api import fetch_origin_ca_cert
    from modules.migration import save_origin_cert

    targets = [d["domain"] for d in get_domains()
               if d["cf_zone_id"] and not d["origin_cert_pem"]]
    if not targets:
        flash("All domains already have cached Origin certs — nothing to backfill.",
              "info")
        return redirect(url_for("settings"))

    def _run():
        from modules.pipeline import HeartbeatTicker
        ok, fail = 0, 0
        for domain in targets:
            # Per-domain ticker — pulses last_heartbeat_at every 1s during the
            # CF round-trip (~1–2s each) so the watcher shows the worker alive.
            with HeartbeatTicker(domain, interval=1.0):
                try:
                    bundle = fetch_origin_ca_cert(domain)
                    save_origin_cert(domain, bundle["certificate"],
                                     bundle["private_key"])
                    ok += 1
                except Exception as e:
                    log_pipeline(domain, "cert_backfill", "warning",
                                 f"re-issue failed: {e}")
                    fail += 1
        log_pipeline("(backfill)", "cert_backfill",
                     "completed" if not fail else "warning",
                     f"Origin cert backfill: ok={ok} fail={fail} total={len(targets)}")

    threading.Thread(target=_run, daemon=True, name="cert-backfill").start()
    flash(f"Backfilling Origin certs for {len(targets)} domain(s) in background. "
          f"Watch the Watcher for progress.", "warning")
    return redirect(url_for("settings"))


@app.route("/api/servers/<int:server_id>/mark-dead", methods=["POST"])
@login_required
def api_mark_server_dead(server_id):
    """Force-mark a server as dead. Useful when you know a droplet is gone
    before the auto-detector's 10-tick threshold trips. Does NOT trigger
    migration — hit 'Migrate Now' separately (keeps the two actions distinct
    so an accidental click can't move 60 sites)."""
    from database import get_db as _get_db
    conn = _get_db()
    try:
        row = conn.execute("SELECT name FROM servers WHERE id=?", (server_id,)).fetchone()
        if not row:
            flash("Server not found", "warning")
            return redirect(url_for("servers_page"))
        conn.execute("UPDATE servers SET status='dead' WHERE id=?", (server_id,))
        conn.commit()
    finally:
        conn.close()
    log_pipeline(f"server-{server_id}", "mark_dead", "warning",
                 f"Manually marked dead by user")
    flash(f"Server '{row['name']}' marked DEAD. Use Migrate Now to move its domains.",
          "warning")
    return redirect(url_for("servers_page"))


@app.route("/api/servers/<int:server_id>/mark-ready", methods=["POST"])
@login_required
def api_mark_server_ready(server_id):
    """Clear a dead-marking (false positive) and restore status='ready'."""
    from database import get_db as _get_db
    from modules import live_checker
    conn = _get_db()
    try:
        row = conn.execute("SELECT name, status FROM servers WHERE id=?",
                           (server_id,)).fetchone()
        if not row:
            flash("Server not found", "warning")
            return redirect(url_for("servers_page"))
        conn.execute("UPDATE servers SET status='ready' WHERE id=?", (server_id,))
        conn.commit()
    finally:
        conn.close()
    # Reset the migrating guard so the detector can fire again if the server
    # actually IS dead. Reset down-streaks for all its domains to avoid an
    # instant re-flip on the next tick.
    with live_checker._migrating_lock:
        live_checker._migrating.discard(server_id)
    for d in get_domains():
        if d["server_id"] == server_id:
            live_checker._streak_down.pop(d["domain"], None)
    log_pipeline(f"server-{server_id}", "mark_ready", "completed",
                 f"Manually restored to 'ready' (was '{row['status']}')")
    flash(f"Server '{row['name']}' restored to 'ready'. Down-streaks reset.",
          "info")
    return redirect(url_for("servers_page"))


@app.route("/api/servers/<int:server_id>/migrate-now", methods=["POST"])
@login_required
def api_migrate_server_now(server_id):
    """Manually trigger migration of every domain off server_id to a new
    server. Optional form field `target_server_id` — if omitted, picks an
    eligible server or provisions a fresh one.

    Fires in a background thread so the request returns immediately.
    Progress is visible in the Watcher (each migrated domain gets heartbeats
    + log_pipeline rows).
    """
    import threading
    from modules.migration import migrate_server
    from modules import live_checker as _lc

    target_id_raw = (request.form.get("target_server_id") or "").strip()
    target_id = int(target_id_raw) if target_id_raw.isdigit() else None

    # R5: Refuse if auto-detection is already running a migration on this
    # server. The _migrating set is the shared "in progress" registry; this
    # prevents a manual click from double-triggering migrate_server(X) while
    # auto-migrate is mid-flight.
    with _lc._migrating_lock:
        if server_id in _lc._migrating:
            flash(f"Server #{server_id} is already being migrated (auto-detected). "
                  f"Watch progress in the Watcher tab.", "warning")
            return redirect(url_for("servers_page"))
        _lc._migrating.add(server_id)

    # Count the domains so we can give the user a sensible flash message.
    count = sum(1 for d in get_domains() if d["server_id"] == server_id)
    if count == 0:
        # Release the slot since we're not actually starting anything.
        with _lc._migrating_lock:
            _lc._migrating.discard(server_id)
        flash(f"Server #{server_id} has no domains — nothing to migrate", "info")
        return redirect(url_for("servers_page"))

    def _run():
        try:
            result = migrate_server(server_id, target_id)
            log_pipeline(
                f"server-{server_id}", "migrate_server",
                "completed" if not result["failed"] else "warning",
                f"{result['msg']}  ok={len(result['ok'])} "
                f"failed={len(result['failed'])}",
            )
        finally:
            with _lc._migrating_lock:
                _lc._migrating.discard(server_id)

    threading.Thread(target=_run, daemon=True,
                     name=f"migrate-server-{server_id}").start()
    audit("migrate_server_manual", target=str(server_id),
          actor_ip=request.remote_addr or "",
          detail=f"domains={count} target_server_id={target_id}")
    flash(
        f"Migration started — moving {count} domain(s) off server #{server_id}. "
        f"Watch progress in the Watcher tab (per-domain heartbeat).",
        "warning",
    )
    return redirect(url_for("servers_page"))


@app.route("/api/servers/destroy-all", methods=["POST"])
@login_required
def api_destroy_all_servers():
    """Emergency kill-switch: tear down EVERY server this dashboard knows about.

    Requires form field `confirm_phrase` to exactly equal "DESTROY ALL".
    Only deletes servers that have NO domains attached (same safety rule as
    single delete). Runs async so the request returns quickly.
    """
    import threading
    from database import get_db
    from modules.digitalocean import delete_droplet as do_delete
    import requests as _rq

    if (request.form.get("confirm_phrase") or "").strip() != "DESTROY ALL":
        flash("Emergency kill-switch requires typing exactly: DESTROY ALL", "danger")
        return redirect(url_for("servers_page"))

    def _worker():
        conn = get_db()
        try:
            srvs = [dict(r) for r in conn.execute("SELECT * FROM servers").fetchall()]
        finally:
            conn.close()

        destroyed = 0
        skipped = []
        for s in srvs:
            # Skip if any domain still references this server
            conn = get_db()
            try:
                ref = conn.execute(
                    "SELECT COUNT(*) FROM domains WHERE server_id=?", (s["id"],)
                ).fetchone()[0]
            finally:
                conn.close()
            if ref:
                skipped.append(f"{s['name']}({ref} domains)")
                continue

            # Tear down droplet (stops billing)
            if s["do_droplet_id"]:
                try:
                    do_delete(s["do_droplet_id"])
                except Exception as e:
                    log_pipeline(s["name"] or f"srv-{s['id']}",
                                 "server_teardown", "warning",
                                 f"DO delete: {e}")

            # Remove from SA
            sa_id = s["sa_server_id"]
            sa_org = s["sa_org_id"] or get_setting("serveravatar_org_id") or ""
            sa_tok = get_setting("serveravatar_api_key") or ""
            if sa_id and sa_org and sa_tok:
                try:
                    _rq.delete(
                        f"https://api.serveravatar.com/organizations/{sa_org}/servers/{sa_id}",
                        headers={"Authorization": sa_tok, "Accept": "application/json"},
                        timeout=30,
                    )
                except Exception:
                    pass

            # Drop DB row
            conn = get_db()
            try:
                conn.execute("DELETE FROM servers WHERE id=?", (s["id"],))
                conn.commit()
            finally:
                conn.close()

            destroyed += 1
            log_pipeline(s["name"] or f"srv-{s['id']}",
                         "server_teardown", "completed",
                         "Destroyed by emergency kill-switch")

        log_pipeline("EMERGENCY", "destroy_all", "completed",
                     f"Destroyed {destroyed} server(s). "
                     f"Skipped (still has domains): {', '.join(skipped) or 'none'}")

    threading.Thread(target=_worker, daemon=True).start()
    audit("destroy_all_servers", actor_ip=request.remote_addr or "")
    flash(
        "Emergency destroy-all started — droplets being torn down in background. "
        "Check pipeline log for per-server results.",
        "warning",
    )
    return redirect(url_for("servers_page"))


# ========================= PROXY IPS =========================

# ========================= NS CHECKER =========================

@app.route("/api/domains/<domain>/check-ns", methods=["POST"])
@login_required
def api_check_ns(domain):
    from modules.cloudflare_api import get_zone_status
    try:
        status = get_zone_status(domain)
        if status == "active":
            flash(f"{domain}: NS propagated — zone ACTIVE", "success")
            update_domain(domain, status="ns_set")
        else:
            flash(f"{domain}: zone status is '{status}' — NS not yet propagated", "warning")
    except Exception as e:
        flash(f"NS check failed: {e}", "danger")
    return redirect(url_for("domains_page"))


@app.route("/api/domains/check-all-ns", methods=["POST"])
@login_required
def api_check_all_ns():
    from modules.cloudflare_api import get_zone_status
    results = {"active": 0, "pending": 0, "errors": 0}
    for d in get_domains():
        if d["cf_email"] and d["cf_global_key"]:
            try:
                status = get_zone_status(d["domain"])
                if status == "active":
                    results["active"] += 1
                else:
                    results["pending"] += 1
            except Exception:
                results["errors"] += 1
    flash(f"NS Check: {results['active']} active, {results['pending']} pending, "
          f"{results['errors']} errors", "info")
    return redirect(url_for("domains_page"))


# ========================= LOGS / WATCHER / STATUS =========================

@app.route("/logs")
@login_required
def logs_page():
    domain_filter = request.args.get("domain")
    logs = get_pipeline_logs(domain=domain_filter, limit=500)
    audit_rows = get_audit_log(limit=200)
    return render_template("logs.html", logs=logs, domain_filter=domain_filter,
                           audit_rows=audit_rows)


@app.route("/watcher")
@login_required
def watcher_page():
    summary = get_watcher_summary()
    domains = get_domains()
    return render_template("watcher.html", summary=summary, domains=domains)


@app.route("/api/watcher")
@login_required
def api_watcher_all():
    summary = get_watcher_summary()
    active = get_all_active_watchers()
    return jsonify({"watchers": summary, "active_domains": active})


@app.route("/api/watcher/<domain>")
@login_required
def api_watcher_domain(domain):
    steps = get_steps(domain)
    return jsonify({"domain": domain, "steps": [dict(s) for s in steps]})


@app.route("/api/heartbeat/<domain>")
@login_required
def api_heartbeat(domain):
    """Return the most recent pipeline heartbeat for this domain, in seconds
    elapsed since it was written. Dashboard polls this ~every second to
    show a live 'pipeline alive' indicator.

    Response:
      {
        "domain":              "<domain>",
        "last_heartbeat_at":   "2026-04-19 08:35:02" | null,
        "seconds_ago":         int | null,
        "alive":               bool       -- true if beat within last 5s
      }
    """
    from database import get_db as _get_db
    import datetime as _dt
    conn = _get_db()
    row = conn.execute(
        "SELECT last_heartbeat_at FROM domains WHERE domain=?", (domain,)
    ).fetchone()
    conn.close()
    if not row or not row["last_heartbeat_at"]:
        return jsonify({"domain": domain, "last_heartbeat_at": None,
                        "seconds_ago": None, "alive": False})
    # SQLite datetime('now') returns UTC in "YYYY-MM-DD HH:MM:SS"
    last = _dt.datetime.strptime(row["last_heartbeat_at"], "%Y-%m-%d %H:%M:%S")
    now_utc = _dt.datetime.utcnow()
    ago = max(0, int((now_utc - last).total_seconds()))
    return jsonify({"domain": domain, "last_heartbeat_at": row["last_heartbeat_at"],
                    "seconds_ago": ago, "alive": ago < 5})


@app.route("/healthz")
def healthz():
    """Unauthenticated liveness probe for uptime monitors and load balancers.
    Returns 200 as long as the Flask app is up AND the DB is readable.
    Deliberately trivial — no secrets, no queries that could fail under load.
    """
    try:
        from database import get_db
        conn = get_db()
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return jsonify({"status": "ok"}), 200
    except Exception as e:
        return jsonify({"status": "degraded", "error": str(e)[:100]}), 503


@app.route("/api/status")
@login_required
def api_status():
    domains = get_domains()
    return jsonify({
        "domains": [dict(d) for d in domains],
        "recent_logs": [dict(l) for l in get_pipeline_logs(limit=10)],
        "active_watchers": get_all_active_watchers()
    })


# ========================= JOB QUEUE BOOT =========================
# Register handlers + boot the durable job worker. Done at module-load
# time AFTER all handler functions are defined (pipeline.pipeline_full_handler,
# _server_create_handler, _teardown_domain, _bulk_teardown). recover_orphans
# resets any 'running' rows left over from a prior process before the new
# worker starts polling, so a crash mid-job doesn't leak the row.
from modules import jobs as _jobs
from modules.pipeline import (
    pipeline_full_handler as _pipeline_full_handler,
    pipeline_bulk_handler as _pipeline_bulk_handler,
)

_jobs.register_handler("pipeline.full",        _pipeline_full_handler)
_jobs.register_handler("pipeline.bulk",        _pipeline_bulk_handler)
_jobs.register_handler("server.create",        _server_create_handler)
_jobs.register_handler("domain.teardown",      lambda p: _teardown_domain(p["domain"]))
_jobs.register_handler("domain.bulk_teardown", lambda p: _bulk_teardown(p["domains"]))
_jobs.recover_orphans()
_jobs.start_worker()


# ========================= RUN =========================

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    debug = bool(os.environ.get("SSR_DEBUG"))   # Only debug if explicitly asked
    # Default to localhost so dev laptops don't expose the dashboard on LAN.
    # Set SSR_BIND_ALL=1 when deploying behind nginx on a droplet.
    bind = "0.0.0.0" if os.environ.get("SSR_BIND_ALL") == "1" else "127.0.0.1"
    print(f"\n  SITE SERVER ROTATION Dashboard")
    print(f"  http://{bind}:{port}  (debug={debug})")
    if bind == "127.0.0.1":
        print(f"  (set SSR_BIND_ALL=1 to expose on all interfaces)\n")
    else:
        print(f"  WARNING: bound to 0.0.0.0 — accessible from network\n")
    app.run(host=bind, port=port, debug=debug)
