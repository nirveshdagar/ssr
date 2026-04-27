/**
 * Multi-channel notifier — Node port of modules/notify.py.
 *
 * Channels (all independent + optional):
 *   1. Email  — SMTP via nodemailer (auto STARTTLS / SSL on port 465)
 *   2. Telegram — Bot API (sendMessage)
 *   3. WhatsApp — CallMeBot OR Green-API, switched by `whatsapp_provider`
 *   4. SMS — Twilio Messages API
 *
 * Each channel runs in parallel (Promise.allSettled) so a slow SMTP server
 * can't delay a Telegram alert. Per-channel results are exposed via
 * notifyStatus().
 *
 * Master gate: `notifications_enabled` must be "1" or NOTHING fires.
 * Per-channel gate: `<channel>_enabled` (e.g., "email_enabled") to opt in.
 *
 * Dedupe: a `dedupeKey` skips duplicates within 10 min — prevents a 60-domain
 * DO outage from paging the operator 60 times.
 */

import nodemailer from "nodemailer"
import { getSetting } from "./repos/settings"
import { logPipeline } from "./repos/logs"

const DEDUPE_WINDOW_S = 600 // 10 minutes

type ChannelResult = { ok: boolean; detail: string }
type Channel = "email" | "telegram" | "whatsapp" | "sms"

const lastStatus: Record<Channel, { ok?: boolean; msg?: string; at?: string }> = {
  email: {}, telegram: {}, whatsapp: {}, sms: {},
}
const lastFired = new Map<string, number>()

function dedupeShouldSkip(key: string | null | undefined): boolean {
  if (!key) return false
  const now = Date.now() / 1000
  const last = lastFired.get(key) ?? 0
  if (now - last < DEDUPE_WINDOW_S) return true
  lastFired.set(key, now)
  return false
}

function stamp(channel: Channel, ok: boolean, msg: string): void {
  lastStatus[channel] = {
    ok, msg,
    at: new Date().toISOString().replace("T", " ").slice(0, 19),
  }
}

export function notifyStatus(): Record<Channel, { ok?: boolean; msg?: string; at?: string }> {
  return {
    email: { ...lastStatus.email },
    telegram: { ...lastStatus.telegram },
    whatsapp: { ...lastStatus.whatsapp },
    sms: { ...lastStatus.sms },
  }
}

// ---------------------------------------------------------------------------
// Email — SMTP via nodemailer
// ---------------------------------------------------------------------------

async function sendEmail(subject: string, body: string): Promise<ChannelResult> {
  const host = (getSetting("smtp_server") || "").trim()
  const portRaw = parseInt(getSetting("smtp_port") || "587", 10)
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587
  const user = (getSetting("smtp_email") || "").trim()
  const pwd = (getSetting("smtp_password") || "").trim()
  const to = (getSetting("notify_email") || "").trim()
  if (!host || !user || !pwd || !to) return { ok: false, detail: "email not configured" }
  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // SSL implicit on 465; STARTTLS otherwise
      auth: { user, pass: pwd },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 15_000,
    })
    await transport.sendMail({
      from: user,
      to,
      subject: `[SSR] ${subject}`,
      text: body,
    })
    return { ok: true, detail: `sent to ${to}` }
  } catch (e) {
    return { ok: false, detail: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegram(subject: string, body: string): Promise<ChannelResult> {
  const tok = (getSetting("telegram_bot_token") || "").trim()
  const chat = (getSetting("telegram_chat_id") || "").trim()
  if (!tok || !chat) return { ok: false, detail: "telegram not configured" }

  const text = `*${subject}*\n\n${body}`.slice(0, 4000)
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      const j = (await r.json()) as { ok?: boolean }
      if (j.ok) return { ok: true, detail: `delivered to chat ${chat}` }
    }
    return { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
  } catch (e) {
    return { ok: false, detail: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// WhatsApp — CallMeBot (default) or Green-API
// ---------------------------------------------------------------------------

async function sendWhatsapp(subject: string, body: string): Promise<ChannelResult> {
  const provider = (getSetting("whatsapp_provider") || "callmebot").trim().toLowerCase()
  if (provider === "greenapi") return sendWhatsappGreenApi(subject, body)
  return sendWhatsappCallMeBot(subject, body)
}

async function sendWhatsappCallMeBot(subject: string, body: string): Promise<ChannelResult> {
  const phone = (getSetting("whatsapp_phone") || "").trim().replace(/^\+/, "")
  const apikey = (getSetting("whatsapp_apikey") || "").trim()
  if (!phone || !apikey) return { ok: false, detail: "callmebot not configured (phone + apikey required)" }

  const text = `*${subject}*\n\n${body}`.slice(0, 900)
  try {
    const params = new URLSearchParams({ phone, text, apikey })
    const r = await fetch(`https://api.callmebot.com/whatsapp.php?${params}`, {
      signal: AbortSignal.timeout(20_000),
    })
    const responseText = await r.text()
    if (r.ok && (responseText.includes("Message queued") || responseText.includes("Message Sent"))) {
      return { ok: true, detail: `queued to +${phone}` }
    }
    return { ok: false, detail: `HTTP ${r.status}: ${responseText.slice(0, 200)}` }
  } catch (e) {
    return { ok: false, detail: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

async function sendWhatsappGreenApi(subject: string, body: string): Promise<ChannelResult> {
  const instanceId = (getSetting("greenapi_instance_id") || "").trim()
  const apiToken = (getSetting("greenapi_api_token") || "").trim()
  const phone = (getSetting("whatsapp_phone") || "").trim().replace(/^\+/, "")
  if (!instanceId || !apiToken || !phone) {
    return { ok: false, detail: "green-api not configured (instance_id + api_token + whatsapp_phone required)" }
  }
  const digits = phone.replace(/\D/g, "")
  const chatId = `${digits}@c.us`
  const text = `*${subject}*\n\n${body}`.slice(0, 4096)

  const hosts = ["https://api.green-api.com"]
  const regionHost = (getSetting("greenapi_host") || "").trim().replace(/\/$/, "")
  if (regionHost) {
    hosts.unshift(regionHost)
  } else if (instanceId.length >= 4 && /^\d{4}/.test(instanceId)) {
    hosts.push(`https://${instanceId.slice(0, 4)}.api.greenapi.com`)
  }

  let lastErr = ""
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]
    try {
      const r = await fetch(
        `${host}/waInstance${instanceId}/sendMessage/${apiToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, message: text }),
          signal: AbortSignal.timeout(20_000),
        },
      )
      if (r.ok) {
        let mid = ""
        try {
          const j = (await r.json()) as { idMessage?: string }
          mid = j.idMessage ?? ""
        } catch { /* ignore */ }
        return {
          ok: true,
          detail: `sent via ${host}  id=${mid.slice(0, 24)}${mid.length > 24 ? "…" : ""}`,
        }
      }
      if (r.status === 404 && i < hosts.length - 1) {
        lastErr = `HTTP 404 on ${host}`
        continue
      }
      return { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
    } catch (e) {
      lastErr = `${(e as Error).name}: ${(e as Error).message}`
      continue
    }
  }
  return { ok: false, detail: lastErr || "green-api: all hosts failed" }
}

// ---------------------------------------------------------------------------
// SMS — Twilio
// ---------------------------------------------------------------------------

async function sendSms(subject: string, body: string): Promise<ChannelResult> {
  const sid = (getSetting("twilio_account_sid") || "").trim()
  const token = (getSetting("twilio_auth_token") || "").trim()
  const frm = (getSetting("twilio_from_number") || "").trim()
  const to = (getSetting("sms_to_number") || "").trim()
  if (!sid || !token || !frm || !to) return { ok: false, detail: "sms not configured" }

  const text = `[SSR] ${subject}\n${body}`.slice(0, 1500)
  try {
    const auth = Buffer.from(`${sid}:${token}`).toString("base64")
    const params = new URLSearchParams({ From: frm, To: to, Body: text })
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (r.ok) {
      let smsSid = "?"
      try {
        const j = (await r.json()) as { sid?: string }
        smsSid = j.sid ?? "?"
      } catch { /* ignore */ }
      return { ok: true, detail: `sid=${smsSid}` }
    }
    return { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` }
  } catch (e) {
    return { ok: false, detail: `${(e as Error).name}: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Channel registry + enabled gating
// ---------------------------------------------------------------------------

const CHANNELS: Record<Channel, (subject: string, body: string) => Promise<ChannelResult>> = {
  email: sendEmail,
  telegram: sendTelegram,
  whatsapp: sendWhatsapp,
  sms: sendSms,
}

function isEnabled(channel: Channel): boolean {
  return (getSetting(`${channel}_enabled`) || "0") === "1"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NotifyOpts {
  severity?: "info" | "warning" | "error"
  channels?: Channel[]
  blocking?: boolean
  dedupeKey?: string | null
}

export interface NotifyResult {
  skipped?: string
  key?: string
  channels?: Channel[]
  results?: Partial<Record<Channel, ChannelResult>>
}

/**
 * Fan out a message to every enabled channel.
 *
 * `blocking` waits for all sends to complete (used by test endpoints).
 * Otherwise the function returns immediately and sends run in the background.
 *
 * Master off-switch: if settings.notifications_enabled != '1', nothing fires.
 */
export async function notify(
  subject: string, body: string, opts: NotifyOpts = {},
): Promise<NotifyResult> {
  if ((getSetting("notifications_enabled") || "0") !== "1") {
    return { skipped: "notifications_enabled is off" }
  }
  if (dedupeShouldSkip(opts.dedupeKey)) {
    return { skipped: `deduped within ${DEDUPE_WINDOW_S}s`, key: opts.dedupeKey ?? undefined }
  }

  const channels: Channel[] = opts.channels ?? (Object.keys(CHANNELS) as Channel[]).filter(isEnabled)
  const severity = opts.severity ?? "warning"
  const results: Partial<Record<Channel, ChannelResult>> = {}

  async function runOne(name: Channel): Promise<void> {
    const fn = CHANNELS[name]
    if (!fn) return
    const r = await fn(subject, body)
    results[name] = r
    stamp(name, r.ok, r.detail)
    try {
      logPipeline(`(notify-${name})`, "notify", r.ok ? "completed" : "warning",
        `${severity}: ${subject}  [${r.detail}]`)
    } catch { /* ignore */ }
  }

  const promises = channels.map((c) => runOne(c))
  if (opts.blocking) {
    // Bound the per-call wait at 25s so a hung SMTP can't pin the caller
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((r) => setTimeout(r, 25_000)),
    ])
  } else {
    void Promise.allSettled(promises) // fire-and-forget
  }

  return { channels, results }
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

export function notifyServerDead(
  serverId: number, name: string, ip: string, domainCount: number,
): Promise<NotifyResult> {
  const subject = `Server #${serverId} DEAD — ${name}`
  const autoMigrateEnabled = (getSetting("auto_migrate_enabled") || "0") === "1"
  const body =
    `Server marked DEAD by auto-detector.\n` +
    `  ID:   ${serverId}\n` +
    `  Name: ${name}\n` +
    `  IP:   ${ip}\n` +
    `  Domains hosted here: ${domainCount}\n\n` +
    `Auto-migrate will ${autoMigrateEnabled ? "run now" : "NOT run (disabled in Settings)"}.`
  return notify(subject, body, { severity: "error", dedupeKey: `server_dead:${serverId}` })
}

export function notifyMigrationDone(
  serverId: number, msg: string, okCount: number, failCount: number,
): Promise<NotifyResult> {
  const subject = `Migration ${failCount ? "PARTIAL FAIL" : "OK"}: server #${serverId}`
  const body = `${msg}\nSucceeded: ${okCount}\nFailed:    ${failCount}`
  return notify(subject, body, {
    severity: failCount ? "error" : "info",
    dedupeKey: `migration_done:${serverId}:${failCount ? "fail" : "ok"}`,
  })
}

export function notifyPipelineFailure(
  domain: string, step: string | number, error: string,
): Promise<NotifyResult> {
  const subject = `Pipeline failed: ${domain}`
  const body =
    `Domain: ${domain}\nStep: ${step}\nError: ${error}\n\n` +
    `Check the SSR dashboard for details.`
  return notify(subject, body, {
    severity: "error",
    dedupeKey: `pipeline_fail:${domain}:${step}`,
  })
}

export function notifyDoAllFailed(
  context: string, attempts: [string, string][],
): Promise<NotifyResult> {
  const subject = "CRITICAL: all DO tokens rejected"
  const body =
    `Context: ${context}\n\n` +
    `Attempted tokens:\n` +
    attempts.map(([lbl, err]) => `  ${lbl}: ${err}`).join("\n") +
    `\n\nAdd a working token to Settings → DigitalOcean immediately — ` +
    `auto-migrate cannot provision replacement servers until at least one token works.`
  return notify(subject, body, { severity: "error", dedupeKey: "do_all_failed" })
}
