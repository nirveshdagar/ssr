"""Probe v3: use explicit wait for 'Force HTTP to HTTPS' text, then
walk up the DOM to find the switch / button sibling."""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from patchright.sync_api import sync_playwright
from database import get_setting

os.makedirs("data/sa_ui_debug", exist_ok=True)
email = get_setting("sa_dashboard_email")
password = get_setting("sa_dashboard_password")

ORG, SRV, APP = 7254, 40468, 141660

JS_FIND = r"""() => {
    // find ALL nodes whose direct text equals 'Force HTTP to HTTPS'
    const xp = document.evaluate(
        "//*[contains(normalize-space(text()), 'Force HTTP to HTTPS')]",
        document, null, XPathResult.ANY_TYPE, null);
    const nodes = [];
    let n; while ((n = xp.iterateNext())) nodes.push(n);
    if (nodes.length === 0) return {error: 'no Force HTTP text'};
    const label = nodes[0];
    // climb up 4 levels, dump each level + all child interactables
    const levels = [];
    let cur = label;
    for (let i = 0; i < 6 && cur; i++) {
        const r = cur.getBoundingClientRect();
        const kids = Array.from(cur.querySelectorAll('button, input, [role="switch"], [role="checkbox"], [type="checkbox"]'));
        levels.push({
            level: i, tag: cur.tagName,
            cls: (cur.className || '').toString().slice(0, 200),
            rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
            text: (cur.innerText || '').trim().slice(0, 200),
            html: cur.outerHTML.slice(0, 600),
            kid_count: kids.length,
            kids: kids.map(k => ({
                tag: k.tagName, role: k.getAttribute('role') || '',
                type: k.type || '', id: k.id || '', name: k.name || '',
                cls: (k.className || '').toString().slice(0, 140),
                aria_label: k.getAttribute('aria-label') || '',
                aria_checked: k.getAttribute('aria-checked') || '',
                data_state: k.getAttribute('data-state') || '',
                checked: (k.checked === undefined) ? '' : String(k.checked),
                html: k.outerHTML.slice(0, 400),
            })),
        });
        cur = cur.parentElement;
    }
    return {levels};
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
    # wait long enough for page data + UI to render
    try:
        page.wait_for_selector("text=/Force HTTP to HTTPS/i", timeout=45000)
        print("[wait] 'Force HTTP to HTTPS' text found")
    except Exception as e:
        print(f"[wait] failed to find text: {e}")

    time.sleep(3)

    # scroll Protocol Handling card into view (it may be below the fold)
    try:
        page.locator("text=/Force HTTP to HTTPS/i").first.scroll_into_view_if_needed(timeout=5000)
        time.sleep(1)
    except Exception:
        pass

    snap = f"data/sa_ui_debug/fh3_{int(time.time())}.png"
    page.screenshot(path=snap, full_page=True)
    print(f"[screenshot full] {snap}")

    result = page.evaluate(JS_FIND)
    if result.get("error"):
        print("ERR:", result)
    else:
        for lvl in result["levels"]:
            print(f"\n=== LEVEL {lvl['level']} {lvl['tag']} rect={lvl['rect']} kids={lvl['kid_count']} ===")
            print(f"cls: {lvl['cls']}")
            print(f"text: {lvl['text']!r}")
            if lvl["kid_count"] > 0:
                for k in lvl["kids"]:
                    print(f"  KID {k['tag']}: role={k['role']!r} type={k['type']!r} id={k['id']!r} cls={k['cls']!r}")
                    print(f"      aria_label={k['aria_label']!r} aria_checked={k['aria_checked']!r} data_state={k['data_state']!r} checked={k['checked']!r}")
                    print(f"      HTML: {k['html']}")
                # found at this level — stop climbing further, we know enough
                if lvl["kid_count"] >= 1:
                    print(f"\n>>> STOPPED AT LEVEL {lvl['level']}, card html: {lvl['html']}")
                    break

    print("\n=== browser open 30s ===")
    time.sleep(30)
    br.close()
