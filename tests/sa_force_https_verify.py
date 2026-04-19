"""Verify: flip the Force HTTPS switch OFF manually, then call
_toggle_force_https and confirm it flips back ON."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patchright.sync_api import sync_playwright
from database import get_setting
from modules.serveravatar_ui import _toggle_force_https, _is_on

email = get_setting("sa_dashboard_email")
password = get_setting("sa_dashboard_password")
ORG, SRV, APP = 7254, 40468, 141660
DOMAIN = "deepforest.site"
SELECTOR = ('div.flex.items-center.justify-between:has-text("Force HTTP to HTTPS") '
            'button[role="switch"]')

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=False)
    ctx = br.new_context(viewport={"width": 1366, "height": 900})
    page = ctx.new_page()

    page.goto("https://app.serveravatar.com/login", wait_until="domcontentloaded")
    time.sleep(2)
    page.locator('input[type="email"]').first.fill(email)
    page.locator('input[type="password"]').first.fill(password)
    page.locator('button[type="submit"]').first.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=30000)
    time.sleep(2)

    page.goto(
        f"https://app.serveravatar.com/organizations/{ORG}/servers/{SRV}"
        f"/applications/{APP}/ssl-certificate",
        wait_until="domcontentloaded",
    )
    page.wait_for_selector("text=/Force HTTP to HTTPS/i", timeout=45000)
    time.sleep(3)

    sw = page.locator(SELECTOR).first
    start = sw.get_attribute("aria-checked")
    print(f"[start] aria-checked = {start!r}  is_on={_is_on(start)}")

    # Force it OFF so we can test an OFF→ON transition
    if _is_on(start):
        print("[reset] flipping OFF first")
        sw.click()
        time.sleep(3)
        off = sw.get_attribute("aria-checked")
        print(f"[after reset] aria-checked = {off!r}  is_on={_is_on(off)}")
        assert not _is_on(off), "manual flip-off did not persist"

    print("\n[test] calling _toggle_force_https()")
    _toggle_force_https(page, DOMAIN)
    time.sleep(2)

    sw = page.locator(SELECTOR).first
    end = sw.get_attribute("aria-checked")
    print(f"[end] aria-checked = {end!r}  is_on={_is_on(end)}")
    assert _is_on(end), "toggle did NOT flip to ON"
    print("\nPASS — toggle reliably flips from OFF to ON")

    page.screenshot(path=f"data/sa_ui_debug/fh_pass_{int(time.time())}.png",
                    full_page=True)
    time.sleep(4)
    br.close()
