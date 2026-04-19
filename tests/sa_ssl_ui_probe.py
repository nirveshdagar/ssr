"""Probe 3: SSL has just been removed. Click Custom Installation tab.
   Then list the form fields (cert, key, chain textareas) + Install button."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patchright.sync_api import sync_playwright
from database import get_setting

email, password = get_setting("sa_dashboard_email"), get_setting("sa_dashboard_password")

JS_INPUTS = """() => {
    const out = [];
    for (const el of document.querySelectorAll('textarea, input, button')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        out.push({
            tag: el.tagName, type: el.type || '',
            name: el.name || '', id: el.id || '',
            placeholder: el.placeholder || '',
            label: (el.labels && el.labels[0]?.innerText) || '',
            text: (el.innerText || '').trim().slice(0, 60),
        });
    }
    return out;
}"""

def snap(page, tag):
    p = f"data/sa_ui_debug/custom_{tag}_{int(time.time())}.png"
    page.screenshot(path=p, full_page=True)
    print(f"  [{tag}] -> {p}")

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=False)
    ctx = br.new_context(viewport={"width":1366,"height":900})
    page = ctx.new_page()

    page.goto("https://app.serveravatar.com/login", wait_until="domcontentloaded")
    time.sleep(2)
    page.locator('input[type="email"]').first.fill(email)
    page.locator('input[type="password"]').first.fill(password)
    page.locator('button[type="submit"]').first.click()
    page.wait_for_url(lambda u: "/login" not in u, timeout=30000)
    time.sleep(2)

    page.goto("https://app.serveravatar.com/organizations/7254/servers/40468/applications/141660/ssl-certificate",
              wait_until="domcontentloaded")
    time.sleep(4)

    # Click Custom Installation tab
    print("Trying to click Custom Installation tab...")
    for locator_try in (
        lambda: page.get_by_role("tab", name="Custom Installation", exact=False).first,
        lambda: page.get_by_role("button", name="Custom Installation", exact=False).first,
        lambda: page.locator('text="Custom Installation"').first,
        lambda: page.locator('button:has-text("Custom Installation")').first,
        lambda: page.locator('[role="tab"]:has-text("Custom")').first,
    ):
        try:
            el = locator_try()
            el.click(timeout=4000)
            print("  clicked!")
            break
        except Exception as e:
            print(f"  try failed: {type(e).__name__}")
    time.sleep(3)
    snap(page, "after_tab_click")

    print("\n--- ALL visible inputs/textareas/buttons on page ---")
    for item in page.evaluate(JS_INPUTS):
        if item["tag"] == "BUTTON" and not item["text"]:
            continue
        fields = [f"{k}={v!r}" for k, v in item.items() if v and k not in ("tag","type")]
        print(f"  {item['tag']:8} type={item['type']:10} {' '.join(fields)[:200]}")

    print("\n=== Browser open 40s ===")
    time.sleep(40)
    br.close()
