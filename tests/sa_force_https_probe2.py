"""Probe v2: wait until the Protocol Handling card is visible, screenshot
the REGION around it, and dump every button/input/switch inside that card.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patchright.sync_api import sync_playwright
from database import get_setting

os.makedirs("data/sa_ui_debug", exist_ok=True)
email = get_setting("sa_dashboard_email")
password = get_setting("sa_dashboard_password")

ORG, SRV, APP = 7254, 40468, 141660

JS_INSPECT = r"""() => {
    // find the Protocol Handling card by text
    const all = Array.from(document.querySelectorAll('*'));
    const card = all.find(el =>
        /PROTOCOL HANDLING/i.test(el.innerText || '') &&
        el.querySelectorAll('button, input, [role="switch"]').length > 0 &&
        el.innerText.length < 500
    );
    if (!card) return {error: 'card not found'};
    const rect = card.getBoundingClientRect();
    const kids = Array.from(card.querySelectorAll('button, input, [role="switch"], [role="checkbox"], label, span'));
    const info = kids.map(el => {
        const r = el.getBoundingClientRect();
        return {
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            type: el.type || '',
            id: el.id || '',
            name: el.name || '',
            cls: (el.className || '').toString().slice(0, 160),
            aria_label: el.getAttribute('aria-label') || '',
            aria_checked: el.getAttribute('aria-checked') || '',
            data_state: el.getAttribute('data-state') || '',
            checked: (el.checked === undefined) ? '' : String(el.checked),
            txt: (el.innerText || '').trim().slice(0, 80),
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            html: el.outerHTML.slice(0, 300),
        };
    });
    return {
        card_rect: {x: Math.round(rect.x), y: Math.round(rect.y),
                    w: Math.round(rect.width), h: Math.round(rect.height)},
        card_text: (card.innerText || '').trim().slice(0, 300),
        card_html: card.outerHTML.slice(0, 2000),
        kids: info,
    };
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
    # wait for the loading spinner to go away
    try:
        page.wait_for_selector("text=/Loading SSL Certificate Information/i",
                               state="hidden", timeout=30000)
    except Exception:
        pass
    # wait for the success-installed card to appear (means page is rendered)
    try:
        page.wait_for_selector(
            "text=/Successfully Installed|PROTOCOL HANDLING/i", timeout=30000)
    except Exception:
        pass
    time.sleep(3)

    snap = f"data/sa_ui_debug/fh_loaded_{int(time.time())}.png"
    page.screenshot(path=snap, full_page=True)
    print(f"[screenshot full] {snap}")

    result = page.evaluate(JS_INSPECT)
    if result.get("error"):
        print("ERROR:", result)
    else:
        print("\n=== card rect ===")
        print(result["card_rect"])
        print("\n=== card text ===")
        print(result["card_text"])
        print("\n=== card HTML (first 2k) ===")
        print(result["card_html"])
        print("\n=== kids (buttons/inputs/switches inside card) ===")
        for k in result["kids"]:
            fields = [f"{kk}={vv!r}" for kk, vv in k.items()
                      if vv and kk not in ("html", "tag")]
            print(f"  {k['tag']:8} {' '.join(fields)[:260]}")
            if k["tag"] in ("BUTTON", "INPUT") or k.get("role") in ("switch", "checkbox"):
                print(f"    HTML: {k['html']}")

        # Screenshot just the card area
        cr = result["card_rect"]
        clip_snap = f"data/sa_ui_debug/fh_card_{int(time.time())}.png"
        try:
            page.screenshot(
                path=clip_snap,
                clip={"x": max(cr["x"]-10, 0), "y": max(cr["y"]-10, 0),
                      "width": cr["w"]+20, "height": cr["h"]+20},
            )
            print(f"\n[screenshot clip] {clip_snap}")
        except Exception as e:
            print(f"clip screenshot fail: {e}")

    print("\n=== browser open 30s ===")
    time.sleep(30)
    br.close()
