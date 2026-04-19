"""UI-automation fallback for SA Custom SSL install.

SA's REST `/ssl` endpoint returns HTTP 500 "Something went wrong while
creating custom ssl certificate" for fresh apps — a well-known server-side
bug. This module drives the SA web UI with patchright (headless Chromium)
to install the cert like a human would.

All selectors in this file were verified against the live SA dashboard as
of 2026-04-19 (see tests/sa_ssl_ui_probe.py).

Flow:
    1. Launch headless Chromium
    2. Log into app.serveravatar.com
    3. Navigate to /organizations/{org}/servers/{srv}/applications/{app}/ssl-certificate
    4. Wait for the "Loading SSL Certificate Information" spinner to hide
    5. If an SSL is already installed (button "Remove SSL Certificate"):
         click it → confirm "Yes, I'm sure" dialog → wait for removal toast
    6. Click the "Custom Installation" tab
    7. Fill three textareas: certificate, private_key, chain_file (optional)
    8. Click "Install Custom Certificate"
    9. Wait for success toast

Requirements:
    - sa_dashboard_email + sa_dashboard_password in DB settings
    - SA account's "Login IP whitelist" must include this machine's IP
      (so login doesn't prompt for 2FA)
"""
from __future__ import annotations

import os
import time

from database import get_setting, log_pipeline

DASHBOARD_URL = "https://app.serveravatar.com"


class SADashboardError(Exception):
    """UI automation failure — caller can fall back to SSH install."""


def install_custom_ssl_via_ui(
    org_id: str,
    server_id: str,
    app_id: str,
    domain: str,
    cert_pem: str,
    key_pem: str,
    chain_pem: str = "",
    headless: bool = True,
    screenshot_on_fail: bool = True,
    force_https: bool = True,
) -> tuple[bool, str]:
    """Install a custom SSL cert via SA's web UI. Returns (ok, message).

    Raises SADashboardError if the flow can't complete; caller chooses
    whether to fall back (e.g., to SSH install) or propagate.
    """
    email = (get_setting("sa_dashboard_email") or "").strip()
    password = (get_setting("sa_dashboard_password") or "").strip()
    if not email or not password:
        raise SADashboardError(
            "sa_dashboard_email / sa_dashboard_password not set in DB settings"
        )

    from patchright.sync_api import sync_playwright, TimeoutError as PWTimeout

    debug_dir = "data/sa_ui_debug"
    os.makedirs(debug_dir, exist_ok=True)

    def _snap(page, tag):
        if not screenshot_on_fail:
            return None
        path = os.path.join(debug_dir, f"{domain}_{tag}_{int(time.time())}.png")
        try:
            page.screenshot(path=path, full_page=True)
            return path
        except Exception:
            return None

    log_pipeline(domain, "sa_ui_ssl", "running",
                 f"Launching UI automation (org={org_id} srv={server_id} app={app_id})")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless)
        ctx = browser.new_context(viewport={"width": 1366, "height": 900})
        page = ctx.new_page()
        try:
            # ----- 1. Login ------------------------------------------------------
            page.goto(f"{DASHBOARD_URL}/login",
                      wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)
            try:
                page.locator('input[type="email"]').first.fill(email, timeout=5000)
                page.locator('input[type="password"]').first.fill(password, timeout=5000)
                page.locator('button[type="submit"]').first.click(timeout=5000)
            except Exception as e:
                _snap(page, "login_fail")
                raise SADashboardError(f"Login form interaction failed: {e}")
            try:
                page.wait_for_url(lambda u: "/login" not in u, timeout=30000)
            except PWTimeout:
                _snap(page, "login_stuck")
                raise SADashboardError(
                    "Login did not redirect off /login within 30s "
                    "(IP whitelist / 2FA / wrong password?)")
            log_pipeline(domain, "sa_ui_ssl", "running", f"Logged in as {email}")

            # ----- 2. Navigate to the SSL page ----------------------------------
            # REAL URL is `/ssl-certificate`, NOT `/ssl` (that's the API path)
            ssl_url = (f"{DASHBOARD_URL}/organizations/{org_id}"
                       f"/servers/{server_id}/applications/{app_id}/ssl-certificate")
            page.goto(ssl_url, wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_selector(
                    "text=/Loading SSL Certificate Information/i",
                    state="hidden", timeout=20000,
                )
            except Exception:
                pass  # spinner may never render if connection is fast
            time.sleep(2)

            # ----- 3. If SSL already installed, click Remove + confirm ---------
            try:
                remove_btn = page.get_by_role(
                    "button", name="Remove SSL Certificate", exact=False
                ).first
                if remove_btn.is_visible(timeout=3000):
                    log_pipeline(domain, "sa_ui_ssl", "running",
                                 "Removing existing SSL first")
                    remove_btn.click(timeout=5000)
                    time.sleep(2)
                    # Confirm dialog — verified real button label is "Yes, I'm sure"
                    try:
                        page.get_by_role(
                            "button", name="Yes, I'm sure", exact=False
                        ).first.click(timeout=5000)
                    except Exception:
                        # fallback to any affirmative button
                        for name in ("Yes", "Confirm", "Remove", "OK"):
                            try:
                                page.get_by_role(
                                    "button", name=name, exact=False
                                ).first.click(timeout=2000)
                                break
                            except Exception:
                                continue
                    # Wait for removal to complete — the install-options UI
                    # appears when it's done (look for "Custom Installation" text)
                    try:
                        page.wait_for_selector(
                            "text=/Custom Installation/i", timeout=30000,
                        )
                    except Exception:
                        pass
                    time.sleep(3)
            except Exception:
                # No existing SSL — just proceed
                pass

            # ----- 4. Click "Custom Installation" tab ---------------------------
            clicked = False
            for locator_try in (
                lambda: page.locator('button:has-text("Custom Installation")').first,
                lambda: page.get_by_role("tab", name="Custom Installation", exact=False).first,
                lambda: page.get_by_role("button", name="Custom Installation", exact=False).first,
                lambda: page.locator('[role="tab"]:has-text("Custom")').first,
                lambda: page.locator('text="Custom Installation"').first,
            ):
                try:
                    locator_try().click(timeout=4000)
                    clicked = True
                    break
                except Exception:
                    continue
            if not clicked:
                _snap(page, "no_custom_tab")
                raise SADashboardError("Couldn't click the Custom Installation tab")
            time.sleep(2)

            # ----- 5. Fill the three textareas ----------------------------------
            # Verified selectors:
            #   textarea[name=certificate] / #ssl_certificate
            #   textarea[name=private_key] / #private_key
            #   textarea[name=chain_file]  / #chain_file  (optional)
            try:
                page.locator(
                    'textarea[name="certificate"], textarea#ssl_certificate'
                ).first.fill(cert_pem, timeout=5000)
                page.locator(
                    'textarea[name="private_key"], textarea#private_key'
                ).first.fill(key_pem, timeout=5000)
                if chain_pem and chain_pem.strip():
                    try:
                        page.locator(
                            'textarea[name="chain_file"], textarea#chain_file'
                        ).first.fill(chain_pem, timeout=5000)
                    except Exception:
                        pass  # chain is optional — don't fail if missing
            except Exception as e:
                _snap(page, "fill_fail")
                raise SADashboardError(f"Could not fill cert/key textareas: {e}")

            log_pipeline(domain, "sa_ui_ssl", "running",
                         "Cert + key pasted, clicking Install Custom Certificate")

            # ----- 6. Click Install Custom Certificate --------------------------
            # Verified text: "Install Custom Certificate" (NOT "Install SSL Certificate")
            install_clicked = False
            for name in ("Install Custom Certificate", "Install Certificate",
                         "Install", "Save"):
                try:
                    page.get_by_role(
                        "button", name=name, exact=False
                    ).first.click(timeout=5000)
                    install_clicked = True
                    break
                except Exception:
                    continue
            if not install_clicked:
                _snap(page, "no_install_button")
                raise SADashboardError("'Install Custom Certificate' button not found")

            # ----- 7. Wait for success toast / status change --------------------
            # SA shows a green toast at top-right like "SSL certificate has been
            # installed successfully"
            success = False
            try:
                page.wait_for_selector(
                    "text=/successfully installed|has been installed/i",
                    timeout=90000,
                )
                success = True
            except PWTimeout:
                # Alternative indicator: page title / H1 changes to
                # "The SSL Certificate is Successfully Installed"
                try:
                    page.wait_for_selector(
                        "text=/The SSL Certificate is Successfully Installed/i",
                        timeout=15000,
                    )
                    success = True
                except PWTimeout:
                    pass

            if not success:
                _snap(page, "install_no_confirm")
                raise SADashboardError(
                    "No success confirmation after clicking Install "
                    "(check data/sa_ui_debug/ screenshot)"
                )

            log_pipeline(domain, "sa_ui_ssl", "completed",
                         "SSL installed via SA web UI automation")

            # ----- 8. Toggle Force HTTP to HTTPS (optional) --------------------
            # SA's /ssl/force-https API only supports GET/HEAD (returns 405 on
            # POST/PATCH), so the toggle must be driven from the UI.
            if force_https:
                try:
                    _toggle_force_https(page, domain)
                except Exception as e:
                    _snap(page, "force_https_fail")
                    # Don't fail the whole SSL install — cert is already on.
                    log_pipeline(domain, "sa_ui_ssl", "warning",
                                 f"Force HTTPS toggle failed (non-fatal): {e}")

            return True, "Installed via SA UI"

        finally:
            try: browser.close()
            except Exception: pass


_ON_VALUES = {"true", "1", "on", "yes"}


def _is_on(aria_checked: str | None) -> bool:
    return (aria_checked or "").strip().lower() in _ON_VALUES


def _toggle_force_https(page, domain: str) -> None:
    """Click the 'Force HTTP to HTTPS' Headless-UI switch on the SSL page.

    Expected DOM (verified 2026-04-19):
        <div class="flex items-center justify-between gap-3">
          <span>Force HTTP to HTTPS</span>
          <div><button role="switch" aria-checked="0|1|true|false" ...></div>
        </div>

    SA's Headless UI toggles expose aria-checked as "1"/"0" (not "true"/"false").
    """
    label = page.locator('text=/^Force HTTP to HTTPS$/').first
    label.wait_for(state="visible", timeout=15000)
    try:
        label.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass

    switch = page.locator(
        'div.flex.items-center.justify-between:has-text("Force HTTP to HTTPS") '
        'button[role="switch"]'
    ).first
    try:
        switch.wait_for(state="visible", timeout=5000)
    except Exception:
        # Fall back to locating via the label's row ancestor
        switch = label.locator(
            'xpath=ancestor::div[contains(@class,"justify-between")][1]//button[@role="switch"]'
        ).first
        switch.wait_for(state="visible", timeout=5000)

    if _is_on(switch.get_attribute("aria-checked")):
        log_pipeline(domain, "sa_ui_ssl", "running",
                     "Force HTTPS already ON — skipping toggle")
        return

    switch.click(timeout=5000)

    # Wait for aria-checked to flip to an ON value (SA persists via API call)
    for _ in range(30):  # up to ~15s
        time.sleep(0.5)
        if _is_on(switch.get_attribute("aria-checked")):
            log_pipeline(domain, "sa_ui_ssl", "running",
                         "Force HTTP to HTTPS enabled")
            return

    raise SADashboardError(
        "Clicked Force HTTPS switch but aria-checked never flipped to an ON value"
    )
