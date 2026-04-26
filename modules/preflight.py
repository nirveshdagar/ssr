"""Preflight checks for the pipeline.

Run all the credential and capacity validations BEFORE step 1 starts.
Fails fast on misconfiguration instead of letting a pipeline burn 5
minutes provisioning a CF zone before discovering the SA token expired.

Each check returns:
  {ok: bool, message: str, detail: dict | None}

The aggregate endpoint (/api/preflight/<domain>) returns:
  {ok: bool (all green), checks: {check_name: result}}

Checks are intentionally cheap (single API hit each) and run sequentially
— total budget is ~10s on a healthy network.
"""

from __future__ import annotations

from database import get_setting, get_db


def _result(ok: bool, message: str, detail: dict | None = None) -> dict:
    out = {"ok": ok, "message": message}
    if detail:
        out["detail"] = detail
    return out


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------

def check_cf_pool() -> dict:
    """At least one CF key with capacity left in the pool."""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, alias, email, domains_used, max_domains
                 FROM cf_keys
                WHERE is_active = 1 AND domains_used < max_domains""",
        ).fetchall()
        total_active = conn.execute(
            "SELECT COUNT(*) FROM cf_keys WHERE is_active = 1"
        ).fetchone()[0]
    finally:
        conn.close()
    if not rows:
        if total_active == 0:
            return _result(False, "No active CF keys in the pool. Add one in Settings.")
        return _result(False,
            f"All {total_active} active CF keys are at capacity. "
            "Add a new key or raise max_domains on an existing one.")
    available = sum((r["max_domains"] - r["domains_used"]) for r in rows)
    return _result(True,
        f"{len(rows)} key(s) with capacity, {available} domain slot(s) free")


def check_do_token() -> dict:
    """Primary DO token reaches /v2/account."""
    import requests
    tok = (get_setting("do_api_token") or "").strip()
    if not tok:
        return _result(False, "DO_API_TOKEN not set in Settings")
    try:
        r = requests.get(
            "https://api.digitalocean.com/v2/account",
            headers={"Authorization": f"Bearer {tok}"},
            timeout=15,
        )
    except Exception as e:
        return _result(False, f"DO API unreachable: {type(e).__name__}: {e}")
    if not r.ok:
        return _result(False, f"DO API rejected token (HTTP {r.status_code})",
                       {"body": r.text[:140]})
    acc = r.json().get("account", {})
    return _result(True,
        f"DO ok ({acc.get('email', '?')}, droplet_limit={acc.get('droplet_limit')})",
        {"email": acc.get("email"),
         "droplet_limit": acc.get("droplet_limit"),
         "status": acc.get("status")})


def check_sa_auth() -> dict:
    """SA token + org id resolve to a real org."""
    import requests
    tok = (get_setting("serveravatar_api_key") or "").strip()
    org = (get_setting("serveravatar_org_id") or "").strip()
    if not tok:
        return _result(False, "SERVERAVATAR_API_KEY not set in Settings")
    if not org:
        return _result(False, "SERVERAVATAR_ORG_ID not set in Settings")
    try:
        r = requests.get(
            f"https://api.serveravatar.com/organizations/{org}",
            headers={"Authorization": tok, "Accept": "application/json"},
            timeout=15,
        )
    except Exception as e:
        return _result(False, f"SA API unreachable: {type(e).__name__}: {e}")
    if not r.ok:
        return _result(False, f"SA API rejected (HTTP {r.status_code})",
                       {"body": r.text[:140]})
    return _result(True, f"SA ok (org={org})")


def check_spaceship_auth(skip_purchase: bool = False) -> dict:
    """Spaceship token works. Skipped if the operator marked skip_purchase
    (they're using a domain registered elsewhere and don't need our
    Spaceship account)."""
    if skip_purchase:
        return _result(True, "Skipped (skip_purchase=True)")
    import requests
    api_key = (get_setting("spaceship_api_key") or "").strip()
    api_secret = (get_setting("spaceship_api_secret") or "").strip()
    if not api_key or not api_secret:
        return _result(False, "SPACESHIP_API_KEY / _SECRET not both set")
    try:
        r = requests.get(
            "https://spaceship.dev/api/v1/domains?take=1",
            headers={"X-API-Key": api_key, "X-API-Secret": api_secret,
                     "Accept": "application/json"},
            timeout=15,
        )
    except Exception as e:
        return _result(False, f"Spaceship unreachable: {type(e).__name__}: {e}")
    if not r.ok:
        return _result(False, f"Spaceship API rejected (HTTP {r.status_code})",
                       {"body": r.text[:140]})
    return _result(True, "Spaceship ok")


def check_llm_key() -> dict:
    """At least one LLM provider key is configured. Doesn't make a billable
    call — just checks the configured provider's key is present and non-empty.
    The full key validation is the existing /api/settings/test-llm-key path."""
    provider = (get_setting("llm_provider") or "anthropic").strip().lower()
    key = ((get_setting(f"llm_api_key_{provider}") or "").strip()
           or (get_setting("llm_api_key") or "").strip())
    if not key:
        return _result(False, f"LLM provider={provider} but no API key configured")
    return _result(True, f"LLM provider={provider} key configured ({len(key)} chars)")


def check_server_capacity() -> dict:
    """At least one ready server below max_sites, or a working DO token to
    provision a new one (we can spin one up if needed)."""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT s.id, s.name, s.ip,
                    (SELECT COUNT(*) FROM domains d WHERE d.server_id = s.id) AS sites_count,
                    s.max_sites
                 FROM servers s
                WHERE s.status = 'ready'""",
        ).fetchall()
    finally:
        conn.close()
    rows = [dict(r) for r in rows]
    available = [r for r in rows
                 if (r["sites_count"] or 0) < (r["max_sites"] or 60)]
    if available:
        return _result(True,
            f"{len(available)} ready server(s) with capacity",
            {"servers": [{"name": r["name"], "ip": r["ip"],
                          "sites": r["sites_count"], "max": r["max_sites"]}
                         for r in available]})
    if rows:
        return _result(False,
            f"All {len(rows)} ready server(s) are at max_sites. "
            "Pipeline will try to provision a new droplet.")
    return _result(False,
        "No ready servers. Pipeline will try to provision a new droplet "
        "(requires healthy DO token).")


def check_root_password() -> dict:
    """Server root password is set — needed for SSH password auth fallback
    when provisioning a fresh droplet."""
    pw = (get_setting("server_root_password") or "").strip()
    if not pw:
        return _result(False,
            "server_root_password not set. New droplets won't be reachable "
            "via password SSH for setup. Set in Settings.")
    return _result(True, f"Root password set ({len(pw)} chars)")


# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

def run_all(skip_purchase: bool = False) -> dict:
    """Run every check sequentially. Returns the aggregate dict."""
    checks = {
        "cf_pool":         check_cf_pool(),
        "do_token":        check_do_token(),
        "sa_auth":         check_sa_auth(),
        "spaceship_auth":  check_spaceship_auth(skip_purchase=skip_purchase),
        "llm_key":         check_llm_key(),
        "server_capacity": check_server_capacity(),
        "root_password":   check_root_password(),
    }
    return {
        "ok": all(c["ok"] for c in checks.values()),
        "checks": checks,
    }
