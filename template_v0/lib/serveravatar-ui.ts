/**
 * UI-automation fallback for SA Custom SSL install — Node port of
 * modules/serveravatar_ui.py. Uses `patchright` (the patched Playwright
 * fork that evades common bot-detection signals on SA's Cloudflare-fronted
 * dashboard).
 *
 * Why this exists: SA's REST `/ssl` endpoint returns HTTP 500 "Something
 * went wrong while creating custom ssl certificate" for fresh apps — a
 * known server-side bug. We drive the SA web UI like a human would.
 *
 * Optional iproyal proxy: if `iproyal_proxy_url` is set in settings, the
 * browser is launched with that proxy. Format: `http://USER:PASS@host:port`.
 * Memory note (per project SOP): NEVER use the bare machine IP for SA UI
 * automation — always go through a residential proxy.
 *
 * Selectors verified against the live SA dashboard 2026-04-19; same
 * elements the Flask side uses.
 */

import path from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import { getSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"

const DASHBOARD_URL = "https://app.serveravatar.com"

export class SADashboardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SADashboardError"
  }
}

export interface InstallSslUiOpts {
  orgId: string
  serverId: string
  appId: string
  domain: string
  certPem: string
  keyPem: string
  chainPem?: string
  headless?: boolean
  screenshotOnFail?: boolean
  forceHttps?: boolean
}

interface ProxyConfig {
  server: string
  username?: string
  password?: string
}

function loadProxyConfig(): ProxyConfig | null {
  // Settings:
  //   iproyal_proxy_url = "http://USER:PASS@host:port"  OR
  //   iproyal_proxy_server / _username / _password as separate fields
  const url = (getSetting("iproyal_proxy_url") || "").trim()
  if (url) {
    try {
      const u = new URL(url)
      const cfg: ProxyConfig = { server: `${u.protocol}//${u.host}` }
      if (u.username) cfg.username = decodeURIComponent(u.username)
      if (u.password) cfg.password = decodeURIComponent(u.password)
      return cfg
    } catch { /* fall through to component fields */ }
  }
  const server = (getSetting("iproyal_proxy_server") || "").trim()
  if (!server) return null
  const cfg: ProxyConfig = { server }
  const username = (getSetting("iproyal_proxy_username") || "").trim()
  const password = (getSetting("iproyal_proxy_password") || "").trim()
  if (username) cfg.username = username
  if (password) cfg.password = password
  return cfg
}

function debugDir(): string {
  const cwd = process.cwd()
  // Same layout as Flask (data/sa_ui_debug)
  const dataDir = process.env.SSR_DB_PATH ? path.dirname(process.env.SSR_DB_PATH) : path.resolve(cwd, "..", "data")
  const dir = path.join(dataDir, "sa_ui_debug")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const ON_VALUES = new Set(["true", "1", "on", "yes"])
const isOn = (v: string | null | undefined) => ON_VALUES.has((v ?? "").trim().toLowerCase())

/**
 * Install a custom SSL cert via SA's web UI. Returns `{ ok, message }`.
 * Throws `SADashboardError` if the flow can't complete (caller may then
 * fall back to an SSH cert install).
 */
export async function installCustomSslViaUi(
  opts: InstallSslUiOpts,
): Promise<{ ok: boolean; message: string }> {
  const email = (getSetting("sa_dashboard_email") || "").trim()
  const password = (getSetting("sa_dashboard_password") || "").trim()
  if (!email || !password) {
    throw new SADashboardError(
      "sa_dashboard_email / sa_dashboard_password not set in DB settings",
    )
  }

  const headless = opts.headless !== false
  const screenshotOnFail = opts.screenshotOnFail !== false
  const forceHttps = opts.forceHttps !== false
  const dDir = debugDir()
  const proxy = loadProxyConfig()

  // Lazy import — patchright pulls native browser binaries on first use, so
  // only load when the UI path is actually exercised.
  const { chromium } = await import("patchright")

  const snap = async (page: { screenshot: (o: { path: string; fullPage: boolean }) => Promise<unknown> }, tag: string): Promise<string | null> => {
    if (!screenshotOnFail) return null
    const p = path.join(dDir, `${opts.domain}_${tag}_${Math.floor(Date.now() / 1000)}.png`)
    try {
      await page.screenshot({ path: p, fullPage: true })
      return p
    } catch {
      return null
    }
  }

  logPipeline(opts.domain, "sa_ui_ssl", "running",
    `Launching UI automation (org=${opts.orgId} srv=${opts.serverId} app=${opts.appId})` +
    (proxy ? ` via proxy ${proxy.server}` : ""))

  const browser = await chromium.launch({
    headless,
    proxy: proxy ?? undefined,
  })
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const page = await ctx.newPage()

  try {
    // 1. Login
    await page.goto(`${DASHBOARD_URL}/login`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    await page.waitForTimeout(2000)
    try {
      await page.locator('input[type="email"]').first().fill(email, { timeout: 5000 })
      await page.locator('input[type="password"]').first().fill(password, { timeout: 5000 })
      await page.locator('button[type="submit"]').first().click({ timeout: 5000 })
    } catch (e) {
      await snap(page, "login_fail")
      throw new SADashboardError(`Login form interaction failed: ${(e as Error).message}`)
    }
    try {
      await page.waitForURL((u) => !u.toString().includes("/login"), { timeout: 30_000 })
    } catch {
      await snap(page, "login_stuck")
      throw new SADashboardError(
        "Login did not redirect off /login within 30s (IP whitelist / 2FA / wrong password?)",
      )
    }
    logPipeline(opts.domain, "sa_ui_ssl", "running", `Logged in as ${email}`)

    // 2. Navigate to SSL page
    const sslUrl =
      `${DASHBOARD_URL}/organizations/${opts.orgId}` +
      `/servers/${opts.serverId}/applications/${opts.appId}/ssl-certificate`
    await page.goto(sslUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
    try {
      await page.waitForSelector("text=/Loading SSL Certificate Information/i", {
        state: "hidden", timeout: 20_000,
      })
    } catch { /* spinner may never render */ }
    await page.waitForTimeout(2000)

    // 3. If SSL already installed, click Remove + confirm
    try {
      const removeBtn = page.getByRole("button", { name: /Remove SSL Certificate/i }).first()
      if (await removeBtn.isVisible({ timeout: 3000 })) {
        logPipeline(opts.domain, "sa_ui_ssl", "running", "Removing existing SSL first")
        await removeBtn.click({ timeout: 5000 })
        await page.waitForTimeout(2000)
        try {
          await page.getByRole("button", { name: /Yes, I'm sure/i }).first().click({ timeout: 5000 })
        } catch {
          for (const name of ["Yes", "Confirm", "Remove", "OK"] as const) {
            try {
              await page.getByRole("button", { name: new RegExp(name, "i") }).first().click({ timeout: 2000 })
              break
            } catch { /* try next */ }
          }
        }
        try {
          await page.waitForSelector("text=/Custom Installation/i", { timeout: 30_000 })
        } catch { /* ignore */ }
        await page.waitForTimeout(3000)
      }
    } catch { /* no existing SSL — proceed */ }

    // 4. Click "Custom Installation" tab
    let clicked = false
    const customTabSelectors: (() => Promise<void>)[] = [
      async () => { await page.locator('button:has-text("Custom Installation")').first().click({ timeout: 4000 }) },
      async () => { await page.getByRole("tab", { name: /Custom Installation/i }).first().click({ timeout: 4000 }) },
      async () => { await page.getByRole("button", { name: /Custom Installation/i }).first().click({ timeout: 4000 }) },
      async () => { await page.locator('[role="tab"]:has-text("Custom")').first().click({ timeout: 4000 }) },
      async () => { await page.locator('text="Custom Installation"').first().click({ timeout: 4000 }) },
    ]
    for (const tryClick of customTabSelectors) {
      try { await tryClick(); clicked = true; break } catch { /* try next */ }
    }
    if (!clicked) {
      await snap(page, "no_custom_tab")
      throw new SADashboardError("Couldn't click the Custom Installation tab")
    }
    await page.waitForTimeout(2000)

    // 5. Fill the three textareas
    try {
      await page.locator('textarea[name="certificate"], textarea#ssl_certificate')
        .first().fill(opts.certPem, { timeout: 5000 })
      await page.locator('textarea[name="private_key"], textarea#private_key')
        .first().fill(opts.keyPem, { timeout: 5000 })
      if (opts.chainPem && opts.chainPem.trim()) {
        try {
          await page.locator('textarea[name="chain_file"], textarea#chain_file')
            .first().fill(opts.chainPem, { timeout: 5000 })
        } catch { /* chain optional */ }
      }
    } catch (e) {
      await snap(page, "fill_fail")
      throw new SADashboardError(`Could not fill cert/key textareas: ${(e as Error).message}`)
    }
    logPipeline(opts.domain, "sa_ui_ssl", "running",
      "Cert + key pasted, clicking Install Custom Certificate")

    // 6. Click Install Custom Certificate
    let installClicked = false
    for (const name of ["Install Custom Certificate", "Install Certificate", "Install", "Save"] as const) {
      try {
        await page.getByRole("button", { name: new RegExp(name, "i") }).first().click({ timeout: 5000 })
        installClicked = true; break
      } catch { /* try next */ }
    }
    if (!installClicked) {
      await snap(page, "no_install_button")
      throw new SADashboardError("'Install Custom Certificate' button not found")
    }

    // 7. Wait for success toast / status change
    let success = false
    try {
      await page.waitForSelector("text=/successfully installed|has been installed/i", { timeout: 90_000 })
      success = true
    } catch {
      try {
        await page.waitForSelector("text=/The SSL Certificate is Successfully Installed/i", { timeout: 15_000 })
        success = true
      } catch { /* still no */ }
    }
    if (!success) {
      await snap(page, "install_no_confirm")
      throw new SADashboardError(
        "No success confirmation after clicking Install (check data/sa_ui_debug/ screenshot)",
      )
    }
    logPipeline(opts.domain, "sa_ui_ssl", "completed",
      "SSL installed via SA web UI automation")

    // 8. Optional: toggle Force HTTP→HTTPS
    if (forceHttps) {
      try { await toggleForceHttps(page, opts.domain) }
      catch (e) {
        await snap(page, "force_https_fail")
        // Don't fail the whole install — cert is already on
        logPipeline(opts.domain, "sa_ui_ssl", "warning",
          `Force HTTPS toggle failed (non-fatal): ${(e as Error).message}`)
      }
    }
    return { ok: true, message: "Installed via SA UI" }
  } finally {
    try { await browser.close() } catch { /* ignore */ }
  }
}

type PatchrightPage = Awaited<ReturnType<Awaited<ReturnType<typeof import("patchright")["chromium"]["launch"]>>["newContext"]>>["newPage"] extends (...args: unknown[]) => infer R ? Awaited<R> : never

/**
 * Click the "Force HTTP to HTTPS" Headless-UI switch on the SSL page. SA's
 * `/ssl/force-https` REST endpoint refuses POST/PATCH (returns 405), so the
 * toggle MUST be driven from the UI.
 */
async function toggleForceHttps(page: PatchrightPage, domain: string): Promise<void> {
  // Wait for the row to appear
  const label = page.locator('text=/^Force HTTP to HTTPS$/').first()
  await label.waitFor({ state: "visible", timeout: 15_000 })
  try { await label.scrollIntoViewIfNeeded?.({ timeout: 3000 }) } catch { /* ignore */ }

  let switchEl = page.locator(
    'div.flex.items-center.justify-between:has-text("Force HTTP to HTTPS") button[role="switch"]',
  ).first()
  try {
    await switchEl.waitFor({ state: "visible", timeout: 5000 })
  } catch {
    switchEl = page.locator(
      'xpath=//div[contains(@class,"justify-between") and .//*[normalize-space()="Force HTTP to HTTPS"]]//button[@role="switch"]',
    ).first()
    await switchEl.waitFor({ state: "visible", timeout: 5000 })
  }

  if (isOn(await switchEl.getAttribute("aria-checked"))) {
    logPipeline(domain, "sa_ui_ssl", "running", "Force HTTPS already ON — skipping toggle")
    return
  }

  await switchEl.click({ timeout: 5000 })

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (isOn(await switchEl.getAttribute("aria-checked"))) {
      logPipeline(domain, "sa_ui_ssl", "running", "Force HTTP to HTTPS enabled")
      return
    }
  }
  throw new SADashboardError(
    "Clicked Force HTTPS switch but aria-checked never flipped to an ON value",
  )
}
