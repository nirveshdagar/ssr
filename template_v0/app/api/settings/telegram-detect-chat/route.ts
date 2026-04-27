import { NextResponse, type NextRequest } from "next/server"
import { getSetting } from "@/lib/repos/settings"

export const runtime = "nodejs"

interface TelegramChat {
  id: number
  type: string
  title: string
  username: string
  first_name: string
  last_name: string
}

/**
 * Given a Telegram bot token, call getUpdates and return every unique chat
 * the bot has received a message from. Lets the operator click one entry
 * to auto-fill `telegram_chat_id` without visiting api.telegram.org.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const token = (
    (form?.get("telegram_bot_token") as string | null) ||
    getSetting("telegram_bot_token") || ""
  ).trim()
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: "No bot token provided. Paste the token from @BotFather first, then click detect.",
    })
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`,
      })
    }
    const data = (await r.json()) as {
      ok?: boolean
      description?: string
      result?: { message?: Record<string, unknown>; edited_message?: Record<string, unknown> }[]
    }
    if (!data.ok) {
      return NextResponse.json({
        ok: false,
        error: `Telegram API: ${data.description ?? "rejected"}`,
      })
    }

    const chats = new Map<number, TelegramChat>()
    for (const upd of data.result ?? []) {
      const msg = (upd.message ?? upd.edited_message ?? {}) as { chat?: Record<string, unknown> }
      const chat = msg.chat ?? {}
      const cid = chat.id as number | undefined
      if (typeof cid !== "number") continue
      chats.set(cid, {
        id: cid,
        type: String(chat.type ?? "?"),
        title: String(chat.title ?? ""),
        username: String(chat.username ?? ""),
        first_name: String(chat.first_name ?? ""),
        last_name: String(chat.last_name ?? ""),
      })
    }
    const chatList = [...chats.values()]

    let bot: { username: string; name: string } = { username: "", name: "" }
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (meRes.ok) {
        const me = (await meRes.json()) as { result?: { username?: string; first_name?: string } }
        bot = { username: me.result?.username ?? "", name: me.result?.first_name ?? "" }
      }
    } catch { /* non-fatal */ }

    return NextResponse.json({
      ok: true,
      bot,
      chats: chatList,
      hint: chatList.length === 0
        ? "Message your bot in Telegram first, then click this button again — the chat will show up here."
        : "",
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: `${(e as Error).name}: ${(e as Error).message}` })
  }
}
