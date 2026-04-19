"""
ServerAvatar API — manage servers, applications, and files.
Docs: https://serveravatar.com/api-docs/
Auth: Authorization: <token> (NOT Bearer)
Base: https://api.serveravatar.com
"""

import time
import requests
from database import get_setting, update_server, log_pipeline

SA_API = "https://api.serveravatar.com"


def _headers():
    token = get_setting("serveravatar_api_key")
    if not token:
        raise ValueError("ServerAvatar API key not configured. Go to Settings.")
    return {
        "Authorization": token,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }


def _org_id():
    org = get_setting("serveravatar_org_id") or ""
    if not org:
        raise ValueError("ServerAvatar Organization ID not configured. Go to Settings.")
    return org


# ==================== SERVER MANAGEMENT ====================

def create_server(server_name, server_id_db, region="nyc1", size="s-2vcpu-4gb"):
    """
    Create a server via ServerAvatar using a linked cloud provider account.
    POST /organizations/{org_id}/servers

    NOTE: ServerAvatar creates servers through linked cloud provider accounts
    (DigitalOcean, Vultr, etc). You must first link your DO account in the
    ServerAvatar dashboard and pass the cloud_server_provider_id.
    """
    log_pipeline(server_name, "sa_create", "running", f"Creating server via ServerAvatar...")
    try:
        provider_id = get_setting("sa_cloud_provider_id") or ""

        payload = {
            "name": server_name,
            "provider": "digitalocean",
            "cloud_server_provider_id": int(provider_id) if provider_id else 0,
            "version": "24",
            "region": region,
            "sizeSlug": size,
            "ssh_key": False,
            "web_server": "apache2",
            "database_type": "mysql",
            "nodejs": False
        }
        resp = requests.post(
            f"{SA_API}/organizations/{_org_id()}/servers",
            json=payload,
            headers=_headers(),
            timeout=120
        )
        resp.raise_for_status()
        data = resp.json()

        server = data.get("server", data)
        sa_server_id = str(server.get("id", ""))
        ip = server.get("ip", "")

        update_server(server_id_db, sa_server_id=sa_server_id, sa_org_id=_org_id())
        if ip:
            update_server(server_id_db, ip=ip)
        log_pipeline(server_name, "sa_create", "completed",
                     f"Server created (SA ID: {sa_server_id}, IP: {ip})")
        return sa_server_id, ip

    except requests.exceptions.HTTPError as e:
        error_msg = str(e)
        try:
            error_msg = e.response.json().get("message", str(e))
        except Exception:
            pass
        log_pipeline(server_name, "sa_create", "failed", error_msg)
        raise RuntimeError(error_msg)


def connect_existing_server(server_name, server_ip, server_id_db):
    """
    For servers NOT created through SA's cloud integration.
    SA doesn't have a simple 'connect by IP' API — you need to create through
    their cloud provider integration. For existing servers, use SA's Custom Server
    flow from their dashboard, or use SFTP directly for file management.
    """
    log_pipeline(server_name, "sa_connect", "warning",
                 "ServerAvatar requires cloud provider integration for server creation. "
                 "Use their dashboard to connect existing servers, or use SFTP for file uploads.")
    return None, None


def wait_for_server_ready(sa_server_id, timeout=600):
    """Poll until server is provisioned."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            info = get_server_info(sa_server_id)
            status = info.get("agent_status", "") or info.get("status", "")
            if status in ("connected", "active", "1"):
                return True
        except Exception:
            pass
        time.sleep(20)
    return False


def get_server_info(sa_server_id):
    """GET /organizations/{org_id}/servers/{server_id}"""
    resp = requests.get(
        f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}",
        headers=_headers(),
        timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("server", data)


def list_servers():
    """GET /organizations/{org_id}/servers?pagination=0"""
    resp = requests.get(
        f"{SA_API}/organizations/{_org_id()}/servers",
        params={"pagination": 0},
        headers=_headers(),
        timeout=30
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("servers", data.get("data", []))


# ==================== APPLICATION MANAGEMENT ====================

def create_application(sa_server_id, domain):
    """
    Create an application on a SA server.
    POST /organizations/{org_id}/servers/{server_id}/applications

    Uses 'custom' method with the domain as hostname.
    Requires an existing system user on the server.
    """
    import re as _re
    log_pipeline(domain, "sa_create_app", "running", f"Creating app for {domain}")
    try:
        # App name CAN have hyphens (SA accepts those on the name field).
        app_name = domain.replace(".", "-").replace("_", "-")

        # System-user USERNAME must be alphanumeric-only per SA validator
        # (hyphens and dots get "username must only contain letters and numbers").
        # Strip everything non-alphanumeric, lowercase, cap at 20 chars, guarantee
        # non-empty and starts with a letter.
        sys_username = _re.sub(r"[^a-zA-Z0-9]", "", domain).lower()[:20]
        if not sys_username or not sys_username[0].isalpha():
            sys_username = "ssruser" + sys_username  # fall back for weird domains
            sys_username = sys_username[:20]

        # Try to get first system user from server
        system_user_id = _get_system_user_id(sa_server_id)

        payload = {
            "name": app_name,
            "method": "custom",
            "framework": "custom",
            "temp_domain": False,
            "hostname": domain,
            "www": True,
            "php_version": "8.2",
        }

        if system_user_id:
            payload["systemUser"] = "existing"
            payload["systemUserId"] = system_user_id
        else:
            payload["systemUser"] = "new"
            payload["systemUserInfo"] = {
                "username": sys_username,
                "password": get_setting("server_root_password") or "Ssr@Temp2024"
            }

        resp = requests.post(
            f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}/applications",
            json=payload,
            headers=_headers(),
            timeout=60
        )
        resp.raise_for_status()
        data = resp.json()
        app = data.get("application", data)
        app_id = str(app.get("id", ""))
        log_pipeline(domain, "sa_create_app", "completed", f"App created (ID: {app_id})")
        return app_id

    except requests.exceptions.HTTPError as e:
        # Capture the FULL error body — SA returns {"message": "Validation failed",
        # "errors": {"field": ["reason"]}}. The default `.get("message")` alone
        # hides which field actually failed.
        error_msg = str(e)
        try:
            body = e.response.json()
            msg = body.get("message", "")
            errs = body.get("errors") or {}
            if errs:
                bits = []
                for field, reasons in errs.items():
                    if isinstance(reasons, list):
                        bits.append(f"{field}: {', '.join(str(r) for r in reasons)}")
                    else:
                        bits.append(f"{field}: {reasons}")
                error_msg = f"{msg} — " + " | ".join(bits)
            elif msg:
                error_msg = msg
        except Exception:
            pass
        log_pipeline(domain, "sa_create_app", "failed", error_msg[:500])
        raise RuntimeError(error_msg)


def _get_system_user_id(sa_server_id):
    """Try to get the first system user ID from the server."""
    try:
        resp = requests.get(
            f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}/system-users",
            headers=_headers(),
            timeout=15
        )
        if resp.ok:
            data = resp.json()
            users = data.get("systemUsers", data.get("data", []))
            if users:
                return users[0].get("id")
    except Exception:
        pass
    return None


def is_sa_server_alive(sa_server_id) -> bool:
    """Light probe: does SA still know about this server_id?

    Used by pipeline._find_server to auto-detect servers that were manually
    deleted from the SA dashboard — those show up in our DB with
    status='ready' but every call to them 404s. Returns True on HTTP 200,
    False on HTTP 404/401/network error. Times out in 10s.
    """
    try:
        resp = requests.get(
            f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}",
            headers=_headers(), timeout=10,
        )
        return resp.status_code == 200
    except Exception:
        return False


def list_applications(sa_server_id):
    """GET /organizations/{org_id}/servers/{server_id}/applications

    SA returns a paginated response: {"applications": {"current_page": 1,
    "data": [...apps...], "first_page_url": ..., "last_page": N}}. We need
    the `data` array out of that wrapper — earlier code returned the whole
    paginated dict which broke every caller that iterated it.

    This function paginates transparently, returning ALL applications across
    pages as a flat list.
    """
    all_apps = []
    page = 1
    while True:
        resp = requests.get(
            f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}/applications",
            params={"page": page},
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
        # Unwrap the paginated envelope
        paginated = body.get("applications") or {}
        if isinstance(paginated, dict) and "data" in paginated:
            page_apps = paginated.get("data") or []
            all_apps.extend(page_apps)
            if page >= (paginated.get("last_page") or 1):
                break
            page += 1
        else:
            # Fallback: older endpoint shape might just return a list
            flat = paginated if isinstance(paginated, list) else (body.get("data") or [])
            all_apps.extend(flat)
            break
    return all_apps


def delete_application(sa_server_id, domain):
    """
    DELETE /organizations/{org_id}/servers/{server_id}/applications/{app_id}
    Finds app by domain match first, then deletes.
    """
    log_pipeline(domain, "sa_delete_app", "running", f"Deleting {domain} from ServerAvatar...")
    try:
        apps = list_applications(sa_server_id)
        app_id = None
        app_name = domain.replace(".", "-").replace("_", "-")

        for app in apps:
            a = app if isinstance(app, dict) else {}
            if (a.get("primary_domain") == domain
                    or a.get("name") == app_name
                    or domain in str(a.get("primary_domain", ""))):
                app_id = a.get("id")
                break

        if not app_id:
            log_pipeline(domain, "sa_delete_app", "warning", f"App not found on SA server")
            return False, "App not found"

        resp = requests.delete(
            f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}/applications/{app_id}",
            headers=_headers(),
            timeout=60
        )
        resp.raise_for_status()
        log_pipeline(domain, "sa_delete_app", "completed", f"App {app_id} deleted")
        return True, f"Deleted app {app_id}"

    except Exception as e:
        log_pipeline(domain, "sa_delete_app", "failed", str(e))
        return False, str(e)


# ==================== FILE MANAGEMENT ====================

def _find_app_id(sa_server_id, domain):
    """Find application ID by domain."""
    apps = list_applications(sa_server_id)
    app_name = domain.replace(".", "-").replace("_", "-")
    for app in apps:
        a = app if isinstance(app, dict) else {}
        if (a.get("primary_domain") == domain
                or a.get("name") == app_name
                or domain in str(a.get("primary_domain", ""))):
            return a.get("id")
    return None


def upload_site_via_api(sa_server_id, domain, html_content):
    """
    Upload site via SA File Manager API.
    Step 1: Create index.html
      PATCH /organizations/{org}/servers/{srv}/applications/{app}/file-managers/file/create
    Step 2: Write content
      PATCH /organizations/{org}/servers/{srv}/applications/{app}/file-managers/file
    """
    log_pipeline(domain, "upload_site", "running", "Uploading via SA File Manager API")
    try:
        app_id = _find_app_id(sa_server_id, domain)
        if not app_id:
            raise RuntimeError(f"App not found on SA server {sa_server_id}")

        base = f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}/applications/{app_id}/file-managers"

        # Create the file first
        resp = requests.patch(
            f"{base}/file/create",
            json={"type": "file", "name": "index.html", "path": "/"},
            headers=_headers(),
            timeout=30
        )
        # 500 with "already exists" is fine
        if resp.status_code == 500:
            body = resp.json() if resp.text else {}
            if "exists" not in str(body.get("message", "")).lower():
                resp.raise_for_status()

        # Write content to the file
        resp = requests.patch(
            f"{base}/file",
            json={
                "filename": "index.html",
                "path": "/",
                "body": html_content
            },
            headers=_headers(),
            timeout=60
        )
        resp.raise_for_status()
        log_pipeline(domain, "upload_site", "completed", "Uploaded via SA File Manager")
        return True

    except Exception as e:
        log_pipeline(domain, "upload_site_api", "warning",
                     f"SA API upload failed ({e}), falling back to SFTP...")
        return upload_site_via_sftp(domain, html_content)


def upload_site_via_sftp(domain, html_content, server_ip=None):
    """Fallback: upload via SFTP directly."""
    import paramiko
    log_pipeline(domain, "upload_site", "running", "Uploading via SFTP")
    try:
        if not server_ip:
            from database import get_domain, get_servers
            d = get_domain(domain)
            if d and d["server_id"]:
                for s in get_servers():
                    if s["id"] == d["server_id"]:
                        server_ip = s["ip"]
                        break
        if not server_ip:
            raise ValueError("No server IP found for SFTP upload")

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        root_pass = get_setting("server_root_password") or ""
        ssh.connect(server_ip, username="root", password=root_pass, timeout=30)

        sftp = ssh.open_sftp()
        app_name = domain.replace(".", "-").replace("_", "-")

        # Try common SA paths
        paths = [
            f"/home/{app_name}/public_html",
            f"/var/www/{domain}/public_html",
            f"/home/master/{app_name}/public_html",
        ]

        for path in paths:
            try:
                ssh.exec_command(f"mkdir -p {path}")
                time.sleep(1)
                with sftp.file(f"{path}/index.html", "w") as f:
                    f.write(html_content)
                log_pipeline(domain, "upload_site", "completed", f"Uploaded to {path}")
                sftp.close()
                ssh.close()
                return True
            except Exception:
                continue

        sftp.close()
        ssh.close()
        raise RuntimeError("Could not write to any expected path")

    except Exception as e:
        log_pipeline(domain, "upload_site", "failed", str(e))
        raise


def upload_site_files(server_ip, domain, html_content):
    """Primary upload — tries SA API first, falls back to SFTP."""
    from database import get_domain, get_servers
    d = get_domain(domain)
    if d and d["server_id"]:
        for s in get_servers():
            if s["id"] == d["server_id"] and s["sa_server_id"]:
                result = upload_site_via_api(s["sa_server_id"], domain, html_content)
                if result:
                    return True
    return upload_site_via_sftp(domain, html_content, server_ip=server_ip)


# ============================================================================
#  NEW (v2 pipeline) — agent install, custom SSL, and index.php upload
# ============================================================================

def _sa_generate_install_command(server_name, web_server=None,
                                 database_type=None, nodejs=0):
    """Call SA's direct-installation endpoint to get a bash one-liner that
    installs the agent + selected stack on a fresh Ubuntu server.

    Web server and database default to the `sa_install_webserver` and
    `sa_install_database` settings (apache2 / mysql per project spec),
    but can be overridden per call.

    POST /organizations/{org_id}/direct-installation/generate-command
    Returns the install command string.
    """
    if web_server is None:
        web_server = get_setting("sa_install_webserver") or "apache2"
    if database_type is None:
        database_type = get_setting("sa_install_database") or "mysql"
    payload = {
        "name": server_name,
        "web_server": web_server,
        "database_type": database_type,
        "nodejs": int(nodejs) if isinstance(nodejs, (int, bool)) else 0,
        "root_password_available": False,  # we use password auth ourselves
    }
    resp = requests.post(
        f"{SA_API}/organizations/{_org_id()}/direct-installation/generate-command",
        json=payload, headers=_headers(), timeout=30,
    )
    resp.raise_for_status()
    data = resp.json() or {}
    # SA returns the command under various possible keys; be defensive
    cmd = (
        data.get("commands")
        or data.get("command")
        or data.get("install_command")
        or (data.get("data") or {}).get("commands")
        or (data.get("data") or {}).get("command")
        or (data.get("data") or {}).get("install_command")
    )
    if not cmd:
        raise RuntimeError(f"SA did not return an install command. Body: {str(data)[:400]}")
    return cmd


def _wait_for_ssh(ip, password, username="root", max_wait_s=240):
    """Block until SSH is accepting password auth on a fresh droplet.

    Cloud-init takes ~60-120s to finish + sshd reload after boot. Returns a
    live paramiko SSHClient or raises on timeout.
    """
    import paramiko
    import socket
    deadline = time.time() + max_wait_s
    last_err = None
    while time.time() < deadline:
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(ip, username=username, password=password,
                        timeout=10, banner_timeout=20, auth_timeout=20,
                        allow_agent=False, look_for_keys=False)
            return ssh
        except (paramiko.ssh_exception.SSHException, socket.error, EOFError) as e:
            last_err = e
            time.sleep(8)
    raise RuntimeError(f"SSH did not become ready within {max_wait_s}s on {ip}: {last_err}")


def install_agent_on_droplet(droplet_ip, server_name, timeout_install_s=900):
    """Install the ServerAvatar agent on a freshly-provisioned Ubuntu droplet.

    Flow:
      1. Ask SA for a one-liner install command (includes a one-time token).
      2. SSH in as root with the cloud-init-set password.
      3. Run the installer (nginx + mysql + SA agent). Takes ~5-15 min.
      4. Wait for SA's side to report the server as active.
      5. Look up the new sa_server_id via list_servers() match on IP.

    Returns: sa_server_id (str)
    """
    import paramiko
    root_password = get_setting("server_root_password") or ""
    if not root_password:
        raise ValueError("server_root_password not set")

    log_pipeline(server_name, "sa_install", "running",
                 f"Requesting SA install command for {server_name}")
    cmd = _sa_generate_install_command(server_name)

    log_pipeline(server_name, "sa_install", "running",
                 f"Waiting for SSH on {droplet_ip}...")
    ssh = _wait_for_ssh(droplet_ip, root_password, max_wait_s=240)

    try:
        log_pipeline(server_name, "sa_install", "running",
                     f"Running install script on {droplet_ip} (takes 5-15 min)")
        # Run asynchronously via nohup so we can exit SSH immediately; log to a file.
        async_cmd = (
            "mkdir -p /root/sa_install && "
            "cd /root/sa_install && "
            f"echo {cmd!r} > install.sh && "
            "chmod +x install.sh && "
            "nohup bash install.sh > install.log 2>&1 & "
            "echo $! > install.pid"
        )
        _, stdout, stderr = ssh.exec_command(async_cmd, timeout=60)
        stdout.channel.recv_exit_status()

        # Now poll SA side for the server to appear as connected.
        deadline = time.time() + timeout_install_s
        sa_server_id = None
        while time.time() < deadline:
            time.sleep(30)
            for s in list_servers():
                # SA stores server_ip as "server_ip" or "ip"
                s_ip = s.get("server_ip") or s.get("ip") or ""
                if s_ip == droplet_ip:
                    status = s.get("agent_status") or s.get("status") or ""
                    if status in ("connected", "active", "1", 1):
                        sa_server_id = str(s.get("id", ""))
                        break
                    else:
                        sa_server_id = str(s.get("id", ""))  # candidate, not ready yet
            if sa_server_id:
                # Got an ID — check readiness explicitly
                try:
                    info = get_server_info(sa_server_id)
                    status = info.get("agent_status") or info.get("status") or ""
                    if status in ("connected", "active", "1", 1):
                        log_pipeline(server_name, "sa_install", "completed",
                                     f"SA agent active; sa_server_id={sa_server_id}")
                        return sa_server_id
                except Exception:
                    pass

        # Timeout: dump tail of install log for debugging
        try:
            _, stdout, _ = ssh.exec_command("tail -n 50 /root/sa_install/install.log", timeout=15)
            tail = stdout.read().decode("utf-8", errors="replace")
        except Exception:
            tail = "(could not read install.log)"
        raise RuntimeError(
            f"SA agent did not become active within {timeout_install_s}s. "
            f"Install log tail:\n{tail[-1500:]}"
        )
    finally:
        try:
            ssh.close()
        except Exception:
            pass


def install_custom_ssl(sa_server_id, app_id, certificate_pem, private_key_pem,
                       chain_pem="", force_https=True,
                       domain=None, server_ip=None):
    """Install a Cloudflare Origin CA SSL certificate on an SA app.

    Follows the exact sequence from SA's own blog
    (https://serveravatar.com/the-most-stable-cloudflare-and-ssl-setup-for-serveravatar/):

      1. Install AUTOMATIC (Let's Encrypt) SSL first — creates SA's internal
         SSL tracker for this app.
      2. Uninstall via /ssl/destroy — clears the auto cert but leaves the
         tracker in a state ready for a custom install.
      3. Install CUSTOM SSL (our CF Origin CA cert) — SA's tracker now shows
         `installed: true` with ssl_type=custom.

    This three-step dance is what makes SA's dashboard correctly reflect the
    installed state AND what makes each domain's SSL tracked uniquely.
    Calling /ssl with ssl_type=custom on a fresh (no-prior-SSL) app returns
    a generic 500 — the auto-install primes SA's state machine.

    If this API sequence fails at any step, we fall back to an SSH-based
    direct install (writes cert files + reloads apache) so the site still
    ends up with a working cert. The SSH path doesn't update SA's dashboard
    tracker, but the cert IS live.
    """
    base = (f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}"
            f"/applications/{app_id}/ssl")
    hdr = _headers()

    def _attempt_api_flow():
        """Try the blog's API sequence. Returns (ok, message)."""
        # Step 1: install Automatic (Let's Encrypt)
        r = requests.post(
            base,
            json={"ssl_type": "automatic", "force_https": False},
            headers=hdr, timeout=120,
        )
        if not r.ok:
            return False, f"auto-install refused (HTTP {r.status_code}): {r.text[:200]}"
        time.sleep(3)

        # Step 2: uninstall (SA clears the Let's Encrypt cert)
        r = requests.post(f"{base}/destroy", headers=hdr, timeout=30)
        # 200/204 = destroyed; 404 means already gone — both OK
        if r.status_code not in (200, 204, 404):
            return False, f"destroy failed (HTTP {r.status_code}): {r.text[:200]}"
        time.sleep(2)

        # Step 3: install Custom (our CF Origin CA cert)
        r = requests.post(
            base,
            json={
                "ssl_type": "custom",
                "ssl_certificate": certificate_pem.strip() + "\n",
                "private_key": private_key_pem.strip() + "\n",
                "chain_file": (chain_pem or "").strip() + ("\n" if chain_pem else ""),
                "force_https": bool(force_https),
            },
            headers=hdr, timeout=60,
        )
        if not r.ok:
            body = ""
            try:
                body = r.json() or {}
                msg = body.get("message", "")
                errs = body.get("errors") or {}
                if errs:
                    msg += " — " + " | ".join(
                        f"{k}: {', '.join(v) if isinstance(v, list) else v}"
                        for k, v in errs.items())
                body = msg
            except Exception:
                body = r.text[:300]
            return False, f"custom-install refused (HTTP {r.status_code}): {body}"

        # Step 4: verify SA's tracker now shows installed=true
        try:
            gr = requests.get(base, headers=hdr, timeout=15)
            tracker_ok = gr.ok and (gr.json() or {}).get("installed")
        except Exception:
            tracker_ok = None
        return True, (f"SA API sequence complete; tracker installed={tracker_ok}")

    api_ok, api_msg = False, ""
    try:
        api_ok, api_msg = _attempt_api_flow()
    except Exception as e:
        api_msg = f"API flow exception: {e}"

    if api_ok:
        return True, api_msg

    # --- API failed — try UI automation next (reliable, ~35s per domain) ---
    # UI flow: logs into dashboard, clicks Remove if existing SSL, Custom
    # Installation tab, pastes cert+key, clicks Install. Requires
    # sa_dashboard_email + sa_dashboard_password in settings.
    ui_msg = ""
    if domain:
        try:
            from modules.serveravatar_ui import (
                install_custom_ssl_via_ui, SADashboardError,
            )
            # IMPORTANT: send empty chain — SA's UI install writes
            # SSLCertificateChainFile into apache conf when chain is provided,
            # and that chain file breaks mod_ssl ("AH01903: Failed to configure
            # CA certificate chain!"). Leaving chain blank produces a clean
            # apache conf that boots fine.
            ui_ok, ui_msg = install_custom_ssl_via_ui(
                org_id=_org_id(),
                server_id=str(sa_server_id),
                app_id=str(app_id),
                domain=domain,
                cert_pem=certificate_pem,
                key_pem=private_key_pem,
                chain_pem="",
                headless=True,
                force_https=True,
            )
            if ui_ok:
                return True, f"UI install OK ({ui_msg}). SA API had failed: {api_msg}"
        except SADashboardError as e:
            ui_msg = f"UI automation: {e}"
        except Exception as e:
            ui_msg = f"UI automation exception: {type(e).__name__}: {e}"

    # --- UI failed too — last resort: direct SSH cert write ----------------
    if not domain or not server_ip:
        raise RuntimeError(
            f"SA API + UI install both failed, no SSH fallback available "
            f"(need `domain` and `server_ip`). API: {api_msg}  UI: {ui_msg}"
        )
    ssh_ok, ssh_msg = _ssh_install_ssl_files(
        server_ip, domain, certificate_pem, private_key_pem
    )
    if ssh_ok:
        return True, (f"SSH fallback OK ({ssh_msg}). "
                      f"API failed: {api_msg}  UI failed: {ui_msg}")
    raise RuntimeError(
        f"All three paths failed. API: {api_msg}  UI: {ui_msg}  SSH: {ssh_msg}"
    )


def _ssh_install_ssl_files(server_ip, domain, cert_pem, key_pem):
    """Directly SSH into the server and deploy the cert+key, then reload Apache.

    Returns (ok: bool, message: str). Must NEVER crash the caller — all
    failures are caught and returned as (False, reason).
    """
    import paramiko
    try:
        app_name = domain.replace(".", "-").replace("_", "-")
        crt_path = f"/etc/ssl/certs/{app_name}.crt"
        key_path = f"/etc/ssl/private/{app_name}.key"
        conf_path = f"/etc/apache2/sites-enabled/{app_name}-ssl.conf"

        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            server_ip, username="root",
            password=get_setting("server_root_password"),
            timeout=20, allow_agent=False, look_for_keys=False,
        )
        sftp = ssh.open_sftp()

        # 1. Write cert + key
        with sftp.file(crt_path, "w") as f:
            f.write(cert_pem.strip() + "\n")
        with sftp.file(key_path, "w") as f:
            f.write(key_pem.strip() + "\n")

        # 2. Perms (key must be 600, cert 644)
        for cmd in (
            f"chmod 644 {crt_path}",
            f"chmod 600 {key_path}",
            f"chown root:root {crt_path} {key_path}",
            # 3. Comment out SSLCertificateChainFile directive if present (deprecated
            #    in modern Apache, and leftover bad chain files break mod_ssl)
            f"sed -i 's|^\\s*SSLCertificateChainFile|#SSLCertificateChainFile|' {conf_path} 2>/dev/null || true",
            # 4. Ensure the cert path in the conf matches our file (SA uses
            #    {app_name}.crt by convention, but if the conf ever diverges this
            #    normalizes it)
            f"grep -q 'SSLCertificateFile {crt_path}' {conf_path} || "
            f"  sed -i 's|SSLCertificateFile.*|SSLCertificateFile {crt_path}|' {conf_path}",
            f"grep -q 'SSLCertificateKeyFile {key_path}' {conf_path} || "
            f"  sed -i 's|SSLCertificateKeyFile.*|SSLCertificateKeyFile {key_path}|' {conf_path}",
            # 5. Validate + reload apache
            "apachectl configtest 2>&1",
            "systemctl reload apache2 2>&1 || systemctl restart apache2 2>&1",
            "systemctl is-active apache2",
        ):
            _, stdout, stderr = ssh.exec_command(cmd, timeout=20)
            stdout.channel.recv_exit_status()

        # Final sanity: verify Apache is active after the reload
        _, stdout, _ = ssh.exec_command("systemctl is-active apache2", timeout=10)
        active = stdout.read().decode(errors="replace").strip()
        sftp.close()
        ssh.close()
        if active == "active":
            return True, f"cert→{crt_path}  key→{key_path}  apache=active"
        return False, f"apache not active after reload (status: {active})"
    except Exception as e:
        return False, f"ssh install error: {type(e).__name__}: {e}"


def upload_index_php(sa_server_id, domain, php_content):
    """Write index.php to /public_html/ and DELETE the default index.html.

    SA creates a default 15KB welcome `index.html` in public_html when an app
    is first created. Apache's DirectoryIndex prefers `index.html` over
    `index.php`, so we must remove the default file — otherwise Apache serves
    the placeholder forever.

    Order of operations:
      1. Write index.php via SA File Manager API
      2. Delete index.html via SA File Manager API (tries a few verb patterns)
      3. If step 2 didn't succeed, SSH in and `rm` the file as a guaranteed
         fallback — the SFTP path is always authoritative.

    The SA File Manager API's `path` field is RELATIVE to the application
    root, NOT public_html. The correct value is "/public_html/".
    """
    log_pipeline(domain, "upload_index_php", "running",
                 "Writing index.php and deleting default index.html in /public_html/")
    try:
        app_id = _find_app_id(sa_server_id, domain)
        if not app_id:
            raise RuntimeError(f"App not found on SA server {sa_server_id}")
        base = (f"{SA_API}/organizations/{_org_id()}/servers/{sa_server_id}"
                f"/applications/{app_id}/file-managers")

        # --- 1. Write index.php
        resp = requests.patch(
            f"{base}/file/create",
            json={"type": "file", "name": "index.php", "path": "/public_html/"},
            headers=_headers(), timeout=30,
        )
        if resp.status_code == 500:
            body = resp.json() if resp.text else {}
            if "exists" not in str(body.get("message", "")).lower():
                resp.raise_for_status()
        resp = requests.patch(
            f"{base}/file",
            json={"filename": "index.php", "path": "/public_html/",
                  "body": php_content},
            headers=_headers(), timeout=60,
        )
        resp.raise_for_status()

        # --- 2. Try to DELETE index.html via SA File Manager. SA's panel
        # UI uses a delete action but the REST verb isn't formally
        # documented — we try the two plausible patterns and accept any 2xx.
        deleted_via_api = False
        for method, url in (
            ("DELETE", f"{base}/file"),
            ("PATCH",  f"{base}/file/delete"),
            ("POST",   f"{base}/file/delete"),
        ):
            try:
                r = requests.request(
                    method, url,
                    json={"filename": "index.html", "path": "/public_html/"},
                    headers=_headers(), timeout=20,
                )
                if r.ok:
                    deleted_via_api = True
                    break
            except Exception:
                continue

        # --- 3. Guaranteed cleanup via SSH if SA API couldn't do it.
        if not deleted_via_api:
            try:
                _delete_index_html_via_ssh(domain)
                log_pipeline(domain, "upload_index_php", "running",
                             "index.html removed via SSH fallback "
                             "(SA API delete wasn't supported for this app)")
            except Exception as ssh_e:
                # If even SSH failed, LLM content still wins eventually because
                # Apache PHP handler will process index.php — but to be safe,
                # overwrite index.html with the same content as a last resort.
                log_pipeline(domain, "upload_index_php", "warning",
                             f"Could not delete index.html (SA API + SSH both "
                             f"failed: {ssh_e}) — overwriting with PHP content "
                             f"as last-resort")
                _overwrite_index_html_via_api(base, php_content)

        log_pipeline(domain, "upload_index_php", "completed",
                     "index.php written, default index.html removed")
        return True
    except Exception as e:
        log_pipeline(domain, "upload_index_php", "warning",
                     f"SA API path failed ({e}); falling back to full SFTP upload")
        return _upload_index_php_via_sftp(domain, php_content)


def _overwrite_index_html_via_api(base: str, php_content: str) -> None:
    """Last-resort belt-and-braces: if we can't delete index.html, at least
    write the PHP content into it so Apache serves the right thing.
    Visitors would see PHP tags as raw text unless the server runs .html
    through PHP — rare — so this is worse than deletion but better than the
    15KB default welcome page winning DirectoryIndex forever.
    """
    try:
        requests.patch(
            f"{base}/file",
            json={"filename": "index.html", "path": "/public_html/",
                  "body": php_content},
            headers=_headers(), timeout=60,
        )
    except Exception:
        pass


def _delete_index_html_via_ssh(domain, server_ip=None) -> None:
    """SSH in and `rm` the default index.html. Reuses the same path-probing
    logic as _upload_index_php_via_sftp so we find SA's real layout.
    """
    import paramiko, re as _re
    if not server_ip:
        d = get_domain(domain)
        if d and d["server_id"]:
            for s in get_servers():
                if s["id"] == d["server_id"]:
                    server_ip = s["ip"]
                    break
    if not server_ip:
        raise ValueError("No server IP found")

    app_name = domain.replace(".", "-").replace("_", "-")
    sys_user = _re.sub(r"[^a-zA-Z0-9]", "", domain).lower()[:20]
    if not sys_user or not sys_user[0].isalpha():
        sys_user = ("ssruser" + sys_user)[:20]

    root_pass = get_setting("server_root_password") or ""
    if not root_pass:
        raise ValueError("server_root_password not set — can't SSH to delete")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(server_ip, username="root", password=root_pass, timeout=15,
                    allow_agent=False, look_for_keys=False)
        candidate_pubs = [
            f"/home/{sys_user}/{app_name}/public_html",
            f"/home/{sys_user}/public_html",
            f"/home/master/{app_name}/public_html",
            f"/var/www/{domain}/public_html",
        ]
        # One-liner that tries each candidate and removes index.html if found.
        cmd = " || ".join(
            f"(test -f {p}/index.html && rm -f {p}/index.html && echo REMOVED:{p})"
            for p in candidate_pubs
        )
        _, stdout, _ = ssh.exec_command(cmd + " || true", timeout=20)
        stdout.channel.recv_exit_status()
    finally:
        try: ssh.close()
        except Exception: pass


def _upload_index_php_via_sftp(domain, php_content, server_ip=None):
    """SFTP fallback for writing index.php — SA's real layout is
    `/home/{sys_user}/{app_name}/public_html/`, not the older single-dir
    templates the v1 pipeline used. Also deletes the default index.html so
    Apache serves index.php.
    """
    import paramiko, re as _re
    if not server_ip:
        from database import get_domain, get_servers
        d = get_domain(domain)
        if d and d["server_id"]:
            for s in get_servers():
                if s["id"] == d["server_id"]:
                    server_ip = s["ip"]
                    break
    if not server_ip:
        raise ValueError("No server IP found for SFTP upload")

    # Reproduce the SAME sanitization create_application used so the paths match
    app_name = domain.replace(".", "-").replace("_", "-")
    sys_user = _re.sub(r"[^a-zA-Z0-9]", "", domain).lower()[:20]
    if not sys_user or not sys_user[0].isalpha():
        sys_user = ("ssruser" + sys_user)[:20]

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    root_pass = get_setting("server_root_password") or ""
    ssh.connect(server_ip, username="root", password=root_pass, timeout=30,
                allow_agent=False, look_for_keys=False)

    sftp = ssh.open_sftp()

    # Candidate paths in preference order — the first one is SA's real layout.
    candidate_pubs = [
        f"/home/{sys_user}/{app_name}/public_html",     # correct SA layout
        f"/home/{sys_user}/public_html",                # some SA variants
        f"/home/master/{app_name}/public_html",
        f"/var/www/{domain}/public_html",
    ]
    for pub in candidate_pubs:
        try:
            # Probe: does this path exist?
            try:
                sftp.stat(pub)
            except IOError:
                continue
            # Remove the default index.html (ignore failure — may not exist)
            try:
                sftp.remove(f"{pub}/index.html")
            except Exception:
                pass
            # Write index.php
            with sftp.file(f"{pub}/index.php", "w") as f:
                f.write(php_content)
            # Ownership + perms so Apache can read
            ssh.exec_command(
                f"chown {sys_user}:{sys_user} {pub}/index.php 2>/dev/null; "
                f"chmod 644 {pub}/index.php",
                timeout=10,
            )[1].channel.recv_exit_status()
            log_pipeline(domain, "upload_index_php", "completed",
                         f"index.php written to {pub} via SFTP "
                         f"(index.html removed)")
            sftp.close(); ssh.close()
            return True
        except Exception:
            continue
    sftp.close(); ssh.close()
    raise RuntimeError(
        f"Could not find a valid public_html under /home/{sys_user}/… — "
        "SA layout may have changed; verify via the SA dashboard"
    )
