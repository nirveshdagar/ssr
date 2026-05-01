import { NextResponse, type NextRequest } from "next/server"
import { startLogin, cancelLogin, type CliProvider } from "@/lib/llm-cli"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const VALID = new Set<string>(["openai", "anthropic_cli"])

function parseProvider(body: { provider?: string }): CliProvider | null {
  const p = (body.provider || "").toLowerCase()
  return VALID.has(p) ? (p as CliProvider) : null
}

/** Kicks off the CLI's OAuth flow as a detached background process and
 *  returns immediately. The CLI opens the user's browser; the UI polls
 *  /api/llm-cli/status to detect the credentials file appearing. */
export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { provider?: string }
  const provider = parseProvider(body)
  if (!provider) {
    return NextResponse.json({ ok: false, error: "provider must be 'openai' or 'anthropic_cli'" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const result = startLogin(provider)
  appendAudit("llm_cli_login_start", provider, result.ok ? "browser opened" : `rejected: ${result.error}`, ip)
  return NextResponse.json(result)
}

/** Cancel the in-flight login — kills the spawned CLI process. */
export async function DELETE(req: NextRequest): Promise<Response> {
  const url = new URL(req.url)
  const provider = parseProvider({ provider: url.searchParams.get("provider") || undefined })
  if (!provider) {
    return NextResponse.json({ ok: false, error: "provider must be 'openai' or 'anthropic_cli'" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const result = cancelLogin(provider)
  appendAudit("llm_cli_login_cancel", provider, "killed", ip)
  return NextResponse.json(result)
}
