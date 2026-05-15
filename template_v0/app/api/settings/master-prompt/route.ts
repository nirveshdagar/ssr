import { NextResponse, type NextRequest } from "next/server"
import {
  DEFAULT_MASTER_PROMPT,
  getMasterPromptStatus,
  listMasterPromptHistory,
  setMasterPrompt,
} from "@/lib/master-prompt"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * GET — return the current prompt + status (version, last-saved, history
 * count) + the default content (so the editor can show a "Reset" diff).
 * Optional ?history=20 returns the recent N history rows for the diff
 * picker.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url)
  const histRaw = parseInt(url.searchParams.get("history") ?? "", 10)
  const includeHistory = Number.isFinite(histRaw) && histRaw > 0
  const status = getMasterPromptStatus()
  return NextResponse.json({
    ok: true,
    ...status,
    history: includeHistory ? listMasterPromptHistory(Math.min(50, histRaw)) : undefined,
  })
}

/**
 * POST — save a new prompt. Body: { content: string }. Empty / whitespace
 * content = reset to default (history row gets reset=1).
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let content: string
  try {
    const body = (await req.json()) as { content?: unknown }
    content = String(body.content ?? "")
  } catch {
    return NextResponse.json({ ok: false, error: "expected JSON body { content: string }" }, { status: 400 })
  }
  // Sanity cap so an accidental paste of a 10MB blob doesn't blow up the DB.
  if (content.length > 50_000) {
    return NextResponse.json({
      ok: false,
      error: `prompt too large (${content.length} > 50000 chars)`,
    }, { status: 413 })
  }
  const next = setMasterPrompt(content, ip)
  appendAudit(
    "master_prompt_save", "",
    `version=${next.version} bytes=${content.length}` +
    (next.is_default ? " (reset to default)" : ""),
    ip,
  )
  return NextResponse.json({
    ok: true,
    ...next,
    message: next.is_default
      ? `Reset to default (version ${next.version})`
      : `Saved version ${next.version} (${content.length} chars)`,
  })
}

/**
 * DELETE — explicit "reset to default" alias for POST with empty body.
 * Some UIs prefer DELETE semantics on a "remove override" button.
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const next = setMasterPrompt("", ip)
  appendAudit("master_prompt_reset", "", `version=${next.version}`, ip)
  return NextResponse.json({
    ok: true, ...next,
    default_content: DEFAULT_MASTER_PROMPT,
    message: `Reset to default (version ${next.version})`,
  })
}
