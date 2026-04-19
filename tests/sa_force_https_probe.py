"""Probe: after SSL is installed, find the 'Force HTTP to HTTPS' toggle
in the Protocol Handling card. Dump its tag/role/classes + rect so we
can script it.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patchright.sync_api import sync_playwright
from database import get_setting

os.makedirs("data/sa_ui_debug", exist_ok=True)
email = get_setting("sa_dashboard_email")
password = get_setting("sa_dashboard_password")

ORG, SRV, APP = 7254, 40468, 141660

JS_SCAN = r"""() => {
    const out = [];
    const all = document.querySelectorAll('button, input, [role="switch"], [role="checkbox"], label, div');
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const txt = (el.innerText || el.textContent || '').trim().slice(0, 120);
        // only keep elements whose nearest context mentions Force HTTPS / Protocol
        const ctx = (el.closest('div')?.innerText || '').slice(0, 400);
        if (!/force.*https|protocol handling|redirect.*https/i.test(ctx + ' ' + txt)) continue;
        out.push({
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            type: el.type || '',
            id: el.id || '',
            name: el.name || '',
            cls: (el.className || '').toString().slice(0, 120),
            aria: el.getAttribute('aria-label') || '',
            aria_checked: el.getAttribute('aria-checked') || '',
            checked: (el.checked === undefined) ? '' : String(el.checked),
            txt: txt,
            x: Math.round(rect.x), y: Math.round(rect.y),
            w: Math.round(rect.width), h: Math.round(rect.height),
        });
    }
    return out;
}"""

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
    time.sleep(6)

    snap = f"data/sa_ui_debug/force_https_view_{int(time.time())}.png"
    page.screenshot(path=snap, full_page=True)
    print(f"[screenshot] {snap}")

    print("\n--- candidates mentioning Force HTTPS / Protocol Handling ---")
    items = page.evaluate(JS_SCAN)
    # dedupe by (tag, x, y)
    seen = set()
    for it in items:
        key = (it["tag"], it["x"], it["y"], it["w"], it["h"])
        if key in seen:
            continue
        seen.add(key)
        fields = [f"{k}={v!r}" for k, v in it.items() if v and k not in ("tag",)]
        print(f"  {it['tag']:8} {' '.join(fields)[:260]}")

    print("\n=== browser open 40s ===")
    time.sleep(40)
    br.close()
