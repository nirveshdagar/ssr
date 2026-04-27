import { NextResponse, type NextRequest } from "next/server"
import { getSetting, setSetting } from "@/lib/repos/settings"
import { notify, notifyStatus } from "@/lib/notify"

export const runtime = "nodejs"

const VALID_CHANNELS = ["email", "telegram", "whatsapp", "sms"] as const
type Channel = typeof VALID_CHANNELS[number]

/**
 * Fire a test alert. `channel=email|telegram|whatsapp|sms|all`. Ignores the
 * master `notifications_enabled` switch so a test always sends.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const channel = ((form?.get("channel") as string | null) || "all").trim().toLowerCase()

  let chans: Channel[] | undefined
  if (channel !== "all") {
    if (!(VALID_CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json({ ok: false, error: `unknown channel: ${channel}` }, { status: 400 })
    }
    chans = [channel as Channel]
  }

  const prev = getSetting("notifications_enabled")
  setSetting("notifications_enabled", "1")
  try {
    const result = await notify(
      `Test alert (${channel})`,
      "This is a test from your SSR dashboard. If you see this, the channel is working.",
      { severity: "info", channels: chans, blocking: true },
    )
    return NextResponse.json({ ok: true, result, status: notifyStatus() })
  } finally {
    setSetting("notifications_enabled", prev ?? "0")
  }
}
