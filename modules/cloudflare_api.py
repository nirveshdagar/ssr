"""
Cloudflare API manager — works with multiple accounts (one per domain).
Uses Global API Key + email auth (not bearer tokens).
Handles: DNS records, zone info, proxy toggle, SSL settings.
"""

import time
import requests
from database import get_domain, update_domain, log_pipeline

CF_API = "https://api.cloudflare.com/client/v4"

# Transient errors we retry with exponential backoff. 429 respects Retry-After.
_CF_RETRY_STATUSES = {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}
_CF_RETRY_EXC = (requests.Timeout, requests.ConnectionError,
                 requests.exceptions.SSLError)


def _cf_request(method: str, url: str, *, retries: int = 3,
                base_backoff: float = 1.0, **kwargs) -> requests.Response:
    """Issue a CF request with retries on transient errors.

    Retries on: 429 (Retry-After honored), 5xx, timeout, connection errors.
    Does NOT retry on 4xx (other than 429) — those are real client errors.

    Returns the final Response (caller still decides whether to .raise_for_status
    or inspect). Total worst-case delay: base*(1+2+4) = 7s at default settings.
    """
    last_exc = None
    for attempt in range(retries + 1):
        try:
            resp = requests.request(method, url, **kwargs)
        except _CF_RETRY_EXC as e:
            last_exc = e
            if attempt < retries:
                time.sleep(base_backoff * (2 ** attempt))
                continue
            raise
        if resp.status_code in _CF_RETRY_STATUSES and attempt < retries:
            # For 429, Cloudflare returns a Retry-After header in seconds.
            try:
                ra = float(resp.headers.get("Retry-After", "") or 0)
            except ValueError:
                ra = 0
            delay = max(base_backoff * (2 ** attempt), min(ra, 30))
            time.sleep(delay)
            continue
        return resp
    # Exhausted retries — return the last response for the caller to handle.
    return resp  # pragma: no cover (reached only if every retry returned 429/5xx)


def _headers_for_domain(domain):
    """Get auth headers for a specific domain's CF account."""
    d = get_domain(domain)
    if not d:
        raise ValueError(f"Domain {domain} not found in database")
    if not d["cf_email"] or not d["cf_global_key"]:
        raise ValueError(f"Cloudflare credentials not set for {domain}")
    return {
        "X-Auth-Email": d["cf_email"],
        "X-Auth-Key": d["cf_global_key"],
        "Content-Type": "application/json"
    }


def _get_zone_id(domain):
    """Get zone ID for a domain, fetching from API if not cached."""
    d = get_domain(domain)
    if d and d["cf_zone_id"]:
        return d["cf_zone_id"]

    headers = _headers_for_domain(domain)
    resp = _cf_request("GET",f"{CF_API}/zones", params={"name": domain}, headers=headers, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data["result"]:
        zone_id = data["result"][0]["id"]
        update_domain(domain, cf_zone_id=zone_id)
        return zone_id
    raise ValueError(f"Zone not found for {domain}")


# -------------------- Zone management --------------------

def get_zone_details(domain):
    """Get full zone details."""
    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    resp = _cf_request("GET",f"{CF_API}/zones/{zone_id}", headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()["result"]


def get_nameservers(domain):
    """Get assigned nameservers for a zone."""
    details = get_zone_details(domain)
    return details.get("name_servers", [])


def get_zone_status(domain):
    """Check if zone is active (nameservers verified)."""
    details = get_zone_details(domain)
    return details.get("status", "unknown")


# -------------------- DNS records --------------------

def get_dns_records(domain, record_type="A"):
    """Get DNS records for a domain."""
    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    resp = _cf_request("GET",
        f"{CF_API}/zones/{zone_id}/dns_records",
        params={"type": record_type, "name": domain},
        headers=headers,
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()["result"]


def set_dns_a_record(domain, ip, proxied=True):
    """Create or update the A record for a domain to point to an IP."""
    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)

    existing = get_dns_records(domain, "A")

    if existing:
        record_id = existing[0]["id"]
        resp = _cf_request("PUT",
            f"{CF_API}/zones/{zone_id}/dns_records/{record_id}",
            json={"type": "A", "name": domain, "content": ip, "proxied": proxied, "ttl": 1},
            headers=headers,
            timeout=30
        )
    else:
        resp = _cf_request("POST",
            f"{CF_API}/zones/{zone_id}/dns_records",
            json={"type": "A", "name": domain, "content": ip, "proxied": proxied, "ttl": 1},
            headers=headers,
            timeout=30
        )

    resp.raise_for_status()
    result = resp.json()
    if result.get("success"):
        update_domain(domain, current_proxy_ip=ip)
        return True
    return False


def set_dns_a_record_www(domain, ip, proxied=True):
    """Set A record for www subdomain too."""
    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    www_name = f"www.{domain}"

    existing = []
    resp = _cf_request("GET",
        f"{CF_API}/zones/{zone_id}/dns_records",
        params={"type": "A", "name": www_name},
        headers=headers,
        timeout=30
    )
    if resp.ok:
        existing = resp.json().get("result", [])

    if existing:
        record_id = existing[0]["id"]
        resp = _cf_request("PUT",
            f"{CF_API}/zones/{zone_id}/dns_records/{record_id}",
            json={"type": "A", "name": www_name, "content": ip, "proxied": proxied, "ttl": 1},
            headers=headers,
            timeout=30
        )
    else:
        resp = _cf_request("POST",
            f"{CF_API}/zones/{zone_id}/dns_records",
            json={"type": "A", "name": www_name, "content": ip, "proxied": proxied, "ttl": 1},
            headers=headers,
            timeout=30
        )
    resp.raise_for_status()
    return resp.json().get("success", False)


# -------------------- SSL settings --------------------

def set_ssl_mode(domain, mode="full"):
    """Set SSL mode: off, flexible, full, full_strict."""
    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    resp = _cf_request("PATCH",
        f"{CF_API}/zones/{zone_id}/settings/ssl",
        json={"value": mode},
        headers=headers,
        timeout=30
    )
    resp.raise_for_status()
    return resp.json().get("success", False)


def enable_always_https(domain):
    """Enable Always Use HTTPS."""
    zone_id = _get_zone_id(domain)
    headers = _headers_for_domain(domain)
    resp = _cf_request("PATCH",
        f"{CF_API}/zones/{zone_id}/settings/always_use_https",
        json={"value": "on"},
        headers=headers,
        timeout=30
    )
    resp.raise_for_status()
    return resp.json().get("success", False)


def setup_domain_dns(domain, ip):
    """Initial DNS setup: A records + SSL + HTTPS."""
    try:
        set_dns_a_record(domain, ip, proxied=True)
        set_dns_a_record_www(domain, ip, proxied=True)
        set_ssl_mode(domain, "full")
        enable_always_https(domain)
        return True
    except Exception as e:
        log_pipeline(domain, "dns_setup", "failed", str(e))
        return False


def delete_zone(domain):
    """
    Delete a zone (domain) from Cloudflare.
    DELETE /zones/{zone_id}
    """
    log_pipeline(domain, "cf_delete_zone", "running", f"Deleting {domain} zone from Cloudflare...")
    try:
        zone_id = _get_zone_id(domain)
        headers = _headers_for_domain(domain)
        resp = _cf_request("DELETE",
            f"{CF_API}/zones/{zone_id}",
            headers=headers,
            timeout=30
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("success"):
            log_pipeline(domain, "cf_delete_zone", "completed", f"Zone {zone_id} deleted from CF")
            return True, "Zone deleted"
        else:
            msg = str(result.get("errors", "Unknown error"))
            log_pipeline(domain, "cf_delete_zone", "failed", msg)
            return False, msg
    except Exception as e:
        log_pipeline(domain, "cf_delete_zone", "failed", str(e))
        return False, str(e)


# ============================================================================
#  NEW (v2 pipeline) — pool-based zone creation + Origin CA cert issuance
# ============================================================================
#
# These functions assume the domain already has cf_email, cf_global_key, and
# cf_account_id populated on its row (done by cf_key_pool.assign_cf_key_to_domain).
# They DO NOT touch the legacy functions above — they're additive.


CF_ORIGIN_CA_RSA_ROOT_PEM = """\
-----BEGIN CERTIFICATE-----
MIIFBjCCAu6gAwIBAgIRAIp9PhPWLzDvI4a9KQdrNPgwDQYJKoZIhvcNAQELBQAw
gYIxCzAJBgNVBAYTAlVTMRkwFwYDVQQKExBDbG91ZEZsYXJlLCBJbmMuMR0wGwYD
VQQLExRDbG91ZEZsYXJlIE9yaWdpbiBDQTE5MDcGA1UEAxMwQ2xvdWRGbGFyZSBP
cmlnaW4gUlNBIENlcnRpZmljYXRlIEF1dGhvcml0eTAeFw0yMDAxMjgxNjQ4MDBa
Fw0zMDAxMjgxNjQ4MDBaMIGCMQswCQYDVQQGEwJVUzEZMBcGA1UEChMQQ2xvdWRG
bGFyZSwgSW5jLjEdMBsGA1UECxMUQ2xvdWRGbGFyZSBPcmlnaW4gQ0ExOTA3BgNV
BAMTMENsb3VkRmxhcmUgT3JpZ2luIFJTQSBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkw
ggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQDBguRSO20oOS2UHqA4RF/N
ZStHsMRkHxVWZIw9zc+9zWEzpNJqXLo00aPgdIoTv0TDaEngjKnLSTT2mCgISMr3
5v48I/chcDiQyMTrCunbI7ttt7ZjqxdlNuy4ognLcPYG5oKXd1eLsitkH+OcIXdl
HQVY6SPu7eISn0CCkTMSTAlXUlRWkMA6FBKe+24ohsxDWDPLrBmkKOXgVdu9ZGay
3cCOE9jNxDwkpdGDDCX03C7mQliRBxw0sHRxyjq00PDz/iO2hdLv4NJC2sV8EDGj
VCd0DCEjNQsMXNY6XB5tF2Ey7fzCoYPIHe8OjKthgL2Zkxt4uAaNAd2+NvzpxHlO
i4i1+sooLo5cj4CjSc/dkDmqqrCjbPPW4eFbPAx9wZ5lGZtd1Hfa9KJVZmQakiAO
M0eZJ8hxbP/bTCd/d/UApmpqGOqUzOEVBYMXaZ5BUFTRiBkb/vM0B4b3CAxgm5ti
XfMGiFlb0oLFDOuGAQWSrkwagLlAfGrH4FVX5xCyxjwckXx4AiXmCvWwNpxqZ2ug
jtIuHNIhFJ9GHkZUuHlcLkb/N5D6b64uMXHjTIBWSU5Vk59hf5DPkJ6fKjFfM5Ms
vYixxHy8tLT0Kq/+bzHpwn+k+H/3rPt1XB+kbccRuALo7x14U6iAYLp8VF4e8YpW
MoIXhq2LYWTzYzvZrKDa2wIDAQABo2YwZDAOBgNVHQ8BAf8EBAMCAQYwEgYDVR0T
AQH/BAgwBgEB/wIBAjAdBgNVHQ4EFgQUJOhTV118NECHqeuU27rhFnj8KaQwHwYD
VR0jBBgwFoAUJOhTV118NECHqeuU27rhFnj8KaQwDQYJKoZIhvcNAQELBQADggIB
AHwOf9Ur1l0Ar5vFE6PNrZWuDfWbbHA/tRav3/e+bPb0d6yTvw+Ze0PpjRAiLyDC
KSitk4dZB8r/z2IkTMLW3Y3XLlvE1uQSTv3eyXEwOSTyAM7bXnjg9ZbLQKCF0uvg
LwxxJ6sqPHWHRkP9c6yVuvjwLsAx4jwkDiFKJIlBQpSfJZNYoGWXqZ3Z6CbqFr9r
8vQ02TF1DnkDIvCHbYfP2T6c5eF7L2WjH0wFRfPn3HJrAa6tTy+8LaNMj/hw+KNu
VFd/A8wUBp/eQwcINvNHyNYEVPgDE2flhPHiYBWUUO8QEr2Po0KPEgF08WETbI1L
ZiGKdeC6Rgrh3/+eWnYSj8fLTV47oJR8SWYjDfGh+xX8jNbWK2nVyvqAUrO4QiPA
aHyXDYPKLGpFsNqMPjMQMLJsN7/PX5pzPTa+m6zv2K5ICFErb/J1DpoqKn8cB+S2
CHCrV1tk88bJsxE+/z8JCO5W8o0wK8ROZG5iFB5SLw9YJexhO/36YLqlj5xEvBnF
o5xKXIdHHQ9fCoBgvxhyb/qVSvBvV5R3hMyNz6EbM/P6m8owrFb8fcxhR0NHmH2k
ZHm9uLbjLXECBaZEzWGPSdL+IRX2nMPFtqKpNmLQEhL0ebUMiFE+hUPu1uYHi0Pg
lRXxJT+FyLJEOtYoKaFwprWsqsJNB43AwVh8z5DsuAt5
-----END CERTIFICATE-----
"""


def _cf_auth_headers(email, api_key):
    """Auth headers for the CF v4 API using a Global API Key pair."""
    return {
        "X-Auth-Email": email,
        "X-Auth-Key": api_key,
        "Content-Type": "application/json",
    }


def create_zone_for_domain(domain):
    """Add a domain to the CF account (using the key already assigned via the pool).

    The domain row must have cf_email, cf_global_key, and cf_account_id populated
    (done by modules.cf_key_pool.assign_cf_key_to_domain).

    Self-healing: if the zone POST fails because the stored cf_account_id is
    stale (a frequent bug: old code stored user.id instead of account.id), we
    automatically re-fetch the real account id from /accounts and retry once.

    Returns:
      {"zone_id": str, "nameservers": [str, str], "status": str}

    Idempotent: if the zone already exists in this CF account, returns its info
    instead of erroring.
    """
    d = get_domain(domain)
    if not d or not d["cf_email"] or not d["cf_global_key"] or not d["cf_account_id"]:
        raise ValueError(
            f"{domain}: cf_email / cf_global_key / cf_account_id missing — "
            "run cf_key_pool.assign_cf_key_to_domain(domain) first"
        )
    headers = _cf_auth_headers(d["cf_email"], d["cf_global_key"])

    def _attempt(account_id):
        """One POST attempt to /zones with the given account_id."""
        log_pipeline(domain, "cf_add_zone", "running",
                     f"Adding {domain} to CF account {account_id[:12]}...")
        body = {
            "name": domain,
            "account": {"id": account_id},
            "type": "full",       # full zone, CF is authoritative DNS
            "jump_start": False,  # don't auto-import records from old DNS
        }
        return _cf_request("POST",f"{CF_API}/zones", json=body, headers=headers, timeout=30)

    resp = _attempt(d["cf_account_id"])
    data = resp.json() if resp.text else {}

    def _is_account_error(resp_obj, data_obj):
        """Heuristic: does this 4xx look like a stale / bad account id?"""
        if resp_obj.ok:
            return False
        errs = (data_obj or {}).get("errors", []) or []
        # CF error code 1013 = "Account is not a valid account"; 1003/9101 = permission/scope
        codes = {e.get("code") for e in errs}
        if codes & {1013, 1003, 9101}:
            return True
        txt = (resp_obj.text or "").lower()
        return ("account" in txt and ("invalid" in txt or "not a valid" in txt or "not authorized" in txt))

    # Self-heal: stale account_id → fetch real one, retry once
    if _is_account_error(resp, data) and d.get("cf_key_id"):
        log_pipeline(domain, "cf_add_zone", "warning",
                     f"Zone create failed (HTTP {resp.status_code}) — refreshing account_id from /accounts")
        try:
            from modules.cf_key_pool import refresh_cf_account_id
            new_acct = refresh_cf_account_id(d["cf_key_id"])
            resp = _attempt(new_acct)
            data = resp.json() if resp.text else {}
            log_pipeline(domain, "cf_add_zone", "running",
                         f"Retry with fresh account_id {new_acct[:12]}... → HTTP {resp.status_code}")
        except Exception as rexc:
            log_pipeline(domain, "cf_add_zone", "warning",
                         f"Account-id refresh itself failed: {rexc}")

    # Handle "zone already exists in this account" — fetch it instead
    if not resp.ok:
        errs = data.get("errors", []) or []
        already = any(
            e.get("code") in (1061, 1097, 1100) or "already exists" in (e.get("message") or "").lower()
            for e in errs
        )
        if already:
            log_pipeline(domain, "cf_add_zone", "running",
                         "Zone already exists in account — fetching info")
            r2 = _cf_request("GET",f"{CF_API}/zones", params={"name": domain},
                              headers=headers, timeout=30)
            r2.raise_for_status()
            zones = r2.json().get("result") or []
            if not zones:
                raise RuntimeError(f"CF says zone exists but GET returned none: {data}")
            z = zones[0]
        else:
            # Re-read domain row after possible account-id refresh
            resp.raise_for_status()
            z = data.get("result") or {}
    else:
        z = data.get("result") or {}

    zone_id = z.get("id")
    nameservers = z.get("name_servers", []) or []
    status = z.get("status", "pending")

    update_domain(
        domain,
        cf_zone_id=zone_id,
        cf_nameservers=",".join(nameservers),
    )
    log_pipeline(domain, "cf_add_zone", "completed",
                 f"zone_id={zone_id}  ns={','.join(nameservers)}  status={status}")
    return {"zone_id": zone_id, "nameservers": nameservers, "status": status}


def _generate_csr_and_key(domain):
    """Generate an RSA-2048 private key + CSR locally.

    Returns (csr_pem_str, private_key_pem_str). Both are PEM text.
    """
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domain)])
    csr_builder = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(subject)
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName(domain),
                x509.DNSName(f"*.{domain}"),
            ]),
            critical=False,
        )
    )
    csr = csr_builder.sign(key, hashes.SHA256())

    csr_pem = csr.public_bytes(serialization.Encoding.PEM).decode("utf-8")
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    return csr_pem, key_pem


def fetch_origin_ca_cert(domain, validity_days=5475, origin_ca_key=None):
    """Issue a Cloudflare Origin CA cert for the domain (+ wildcard).

    We generate the keypair locally so the private key never leaves this
    machine. CF signs our CSR and returns the certificate. The chain is
    CF's public Origin CA RSA Root.

    Args:
      domain: the apex domain, e.g. "example.com". We request cert for both
              "example.com" and "*.example.com".
      validity_days: one of 7, 30, 90, 365, 730, 1095, 5475 (CF-accepted values).
                     Default 5475 (15 years).
      origin_ca_key: optional. If given, auth via X-Auth-User-Service-Key.
                     Otherwise, fall back to the domain's Global API Key.

    Returns: {"certificate": str, "private_key": str, "chain": str, "id": str, "expires_on": str}
    """
    log_pipeline(domain, "cf_origin_ca", "running",
                 f"Issuing Origin CA cert for {domain} (+*.{domain}), validity={validity_days}d")
    try:
        csr_pem, private_key_pem = _generate_csr_and_key(domain)

        if origin_ca_key:
            headers = {
                "X-Auth-User-Service-Key": origin_ca_key,
                "Content-Type": "application/json",
            }
        else:
            # Fall back to the domain's pool-assigned Global API Key
            d = get_domain(domain)
            if not d or not d["cf_email"] or not d["cf_global_key"]:
                raise ValueError(f"{domain}: no CF credentials available for Origin CA issuance")
            headers = _cf_auth_headers(d["cf_email"], d["cf_global_key"])

        body = {
            "csr": csr_pem,
            "hostnames": [domain, f"*.{domain}"],
            "request_type": "origin-rsa",
            "requested_validity": int(validity_days),
        }
        resp = _cf_request("POST",f"{CF_API}/certificates", json=body, headers=headers, timeout=60)
        data = resp.json() if resp.text else {}
        if not resp.ok or not data.get("success"):
            msg = data.get("errors") or data.get("message") or resp.text[:400]
            log_pipeline(domain, "cf_origin_ca", "failed", str(msg)[:500])
            raise RuntimeError(f"CF Origin CA refused: HTTP {resp.status_code} — {msg}")

        result = data.get("result") or {}
        cert_pem = result.get("certificate") or ""
        if not cert_pem:
            raise RuntimeError(f"CF Origin CA returned no certificate: {data}")

        log_pipeline(domain, "cf_origin_ca", "completed",
                     f"cert id={result.get('id')} expires={result.get('expires_on')}")
        return {
            "certificate": cert_pem,
            "private_key": private_key_pem,
            "chain": CF_ORIGIN_CA_RSA_ROOT_PEM,
            "id": result.get("id", ""),
            "expires_on": result.get("expires_on", ""),
        }
    except Exception as e:
        log_pipeline(domain, "cf_origin_ca", "failed", str(e)[:500])
        raise
