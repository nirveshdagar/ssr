"""Discovery v2: login, try multiple likely URL patterns for the app's SSL
page, screenshot each. Also click through the UI manually (Applications →
deepforest-site → SSL) to observe the real URL."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patchright.sync_api import sync_playwright
from database import get_setting

os.makedirs("data/sa_ui_debug", exist_ok=True)
email = get_setting("sa_dashboard_email")
password = get_setting("sa_dashboard_password")

def snap(page, tag):
    path = f"data/sa_ui_debug/v2_{tag}_{int(time.time())}.png"
    try:
        page.screenshot(path=path, full_page=True)
        print(f"  [{tag}] {page.url}  ->  {path}")
    except Exception as e:
        print(f"  [{tag}] screenshot err: {e}")

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=False)
    ctx = br.new_context(viewport={"width":1366,"height":900})
    page = ctx.new_page()

    # Login
    page.goto("https://app.serveravatar.com/login", wait_until="domcontentloaded", timeout=30000)
    time.sleep(2)
    page.locator('input[type="email"]').first.fill(email)
    page.locator('input[type="password"]').first.fill(password)
    page.locator('button[type="submit"]').first.click()
    try: page.wait_for_url(lambda u: "/login" not in u, timeout=30000)
    except Exception: pass
    time.sleep(3)
    print(f"after login: {page.url}")

    # Click the "Applications" link in the left sidebar
    try:
        page.get_by_role("link", name="Applications", exact=False).first.click(timeout=5000)
        time.sleep(3)
        print(f"Applications page URL: {page.url}")
        snap(page, "applications_list")
    except Exception as e:
        print(f"couldn't click Applications: {e}")

    # Look for "deepforest-site" in the list and click it
    try:
        link = page.get_by_text("deepforest-site", exact=False).first
        href = link.get_attribute("href") or ""
        print(f"deepforest-site link href: {href!r}")
        link.click()
        time.sleep(3)
        print(f"after clicking deepforest-site: {page.url}")
        snap(page, "app_dashboard")
    except Exception as e:
        print(f"couldn't find/click deepforest-site: {e}")

    # From app dashboard, look for SSL in the sub-menu
    try:
        ssl = page.get_by_text("SSL", exact=False).first
        href = ssl.get_attribute("href") or ""
        print(f"\\nSSL link href: {href!r}")
        ssl.click()
        time.sleep(3)
        print(f"after clicking SSL: {page.url}")
        snap(page, "ssl_page")
    except Exception as e:
        print(f"couldn't find SSL link: {e}")

    # Look for "Custom Installation" text or tab on the SSL page
    try:
        custom = page.get_by_text("Custom Installation", exact=False).first
        print(f"\\nCustom Installation found. Clicking...")
        custom.click()
        time.sleep(3)
        print(f"after clicking Custom Installation: {page.url}")
        snap(page, "custom_install_form")
    except Exception as e:
        print(f"Custom Installation not found: {e}")

    print("\\n=== Leave browser open 30s to inspect visually ===")
    time.sleep(30)
    br.close()
