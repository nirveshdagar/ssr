"""
Spaceship Domain Registrar API — purchase domains and manage nameservers.
Docs: https://docs.spaceship.dev/
Auth: X-API-Key + X-API-Secret headers
Note: Domain deletion returns 501 (not implemented by Spaceship).
"""

import time
import requests
from database import get_setting, log_pipeline

API_BASE = "https://spaceship.dev/api/v1"


def _headers():
    api_key = get_setting("spaceship_api_key")
    api_secret = get_setting("spaceship_api_secret")
    if not api_key or not api_secret:
        raise ValueError("Spaceship API credentials not configured. Go to Settings.")
    return {
        "X-API-Key": api_key,
        "X-API-Secret": api_secret,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }


def check_availability(domains):
    """
    Check domain availability.
    POST /domains/available  body: {"domains": ["example.com"]}
    """
    if isinstance(domains, str):
        domains = [domains]
    resp = requests.post(
        f"{API_BASE}/domains/available",
        json={"domains": domains},
        headers=_headers(),
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()


def _poll_async_operation(operation_id, timeout=120):
    """Poll an async operation until it completes."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = requests.get(
            f"{API_BASE}/async-operations/{operation_id}",
            headers=_headers(),
            timeout=30
        )
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status", "")
        if status == "success":
            return True, data
        elif status == "failed":
            return False, data.get("error", "Operation failed")
        time.sleep(5)
    return False, "Operation timed out"


def purchase_domain(domain, years=1):
    """
    Register/purchase a domain.
    POST /domains/{domain}
    Body: { "autoRenew": bool, "years": int, "privacyProtection": {...}, "contacts": {...} }
    Returns HTTP 202 with async operation ID.
    """
    log_pipeline(domain, "domain_purchase", "running", f"Purchasing {domain} for {years} year(s)")
    try:
        # Build contacts from settings
        contacts = {
            "registrant": {
                "firstName": get_setting("registrant_first_name") or "Domain",
                "lastName": get_setting("registrant_last_name") or "Admin",
                "email": get_setting("registrant_email") or "",
                "phone": get_setting("registrant_phone") or "+1.0000000000",
                "address": {
                    "line1": get_setting("registrant_address") or "123 Main St",
                    "city": get_setting("registrant_city") or "New York",
                    "state": get_setting("registrant_state") or "NY",
                    "zip": get_setting("registrant_zip") or "10001",
                    "country": get_setting("registrant_country") or "US"
                }
            }
        }
        # Copy registrant to all contact types
        for role in ("admin", "tech", "billing"):
            contacts[role] = contacts["registrant"]

        payload = {
            "autoRenew": False,
            "years": years,
            "privacyProtection": {"level": "high"},
            "contacts": contacts
        }

        resp = requests.post(
            f"{API_BASE}/domains/{domain}",
            json=payload,
            headers=_headers(),
            timeout=60
        )

        # 202 = async operation started
        if resp.status_code == 202:
            op_id = resp.headers.get("spaceship-async-operationid", "")
            if op_id:
                log_pipeline(domain, "domain_purchase", "running",
                             f"Async operation {op_id} — polling...")
                ok, result = _poll_async_operation(op_id)
                if ok:
                    log_pipeline(domain, "domain_purchase", "completed", f"Domain purchased: {domain}")
                    return True, result
                else:
                    log_pipeline(domain, "domain_purchase", "failed", str(result))
                    return False, str(result)
            # No operation ID but 202 — assume success
            log_pipeline(domain, "domain_purchase", "completed", f"Domain purchased: {domain}")
            return True, resp.json() if resp.text else {}

        resp.raise_for_status()
        log_pipeline(domain, "domain_purchase", "completed", f"Domain purchased: {domain}")
        return True, resp.json()

    except requests.exceptions.HTTPError as e:
        error_msg = str(e)
        try:
            error_msg = e.response.json().get("message", str(e))
        except Exception:
            pass
        log_pipeline(domain, "domain_purchase", "failed", error_msg)
        return False, error_msg
    except Exception as e:
        log_pipeline(domain, "domain_purchase", "failed", str(e))
        return False, str(e)


def set_nameservers(domain, nameservers):
    """
    Set nameservers for a domain.
    PUT /domains/{domain}/nameservers
    Body: {"provider": "custom", "hosts": ["ns1.x.cloudflare.com", "ns2.x.cloudflare.com"]}
    """
    log_pipeline(domain, "set_nameservers", "running", f"Setting NS: {nameservers}")
    try:
        payload = {
            "provider": "custom",
            "hosts": nameservers
        }
        resp = requests.put(
            f"{API_BASE}/domains/{domain}/nameservers",
            json=payload,
            headers=_headers(),
            timeout=30
        )
        resp.raise_for_status()
        log_pipeline(domain, "set_nameservers", "completed", f"NS set to {nameservers}")
        return True
    except requests.exceptions.HTTPError as e:
        error_msg = str(e)
        try:
            error_msg = e.response.json().get("message", str(e))
        except Exception:
            pass
        log_pipeline(domain, "set_nameservers", "failed", error_msg)
        return False
    except Exception as e:
        log_pipeline(domain, "set_nameservers", "failed", str(e))
        return False


def get_domain_info(domain):
    """GET /domains/{domain}"""
    resp = requests.get(
        f"{API_BASE}/domains/{domain}",
        headers=_headers(),
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()


def list_domains(take=25, skip=0):
    """GET /domains?take=25&skip=0"""
    resp = requests.get(
        f"{API_BASE}/domains",
        params={"take": take, "skip": skip},
        headers=_headers(),
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()


def delete_domain(domain):
    """
    DELETE /domains/{domain}
    NOTE: Spaceship API returns 501 (Not Implemented) for this endpoint.
    Domain deletion must be done manually via the Spaceship dashboard.
    """
    log_pipeline(domain, "spaceship_delete", "running", f"Attempting to delete {domain} from Spaceship...")
    try:
        resp = requests.delete(
            f"{API_BASE}/domains/{domain}",
            headers=_headers(),
            timeout=30
        )
        if resp.status_code == 501:
            log_pipeline(domain, "spaceship_delete", "warning",
                         "Spaceship API does not support domain deletion. Delete manually from dashboard.")
            return False, "Not supported by Spaceship API (501). Delete manually."
        resp.raise_for_status()
        log_pipeline(domain, "spaceship_delete", "completed", f"{domain} deleted from Spaceship")
        return True, "Deleted"
    except Exception as e:
        log_pipeline(domain, "spaceship_delete", "failed", str(e))
        return False, str(e)
