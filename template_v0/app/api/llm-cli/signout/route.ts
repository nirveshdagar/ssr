import { NextResponse, type NextRequest } from "next/server"
import { signOut, type CliProvider } from "@/lib/llm-cli"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const VALID = new Set<string>(["openai", "anthropic_cli"])

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { provider?: string }
  const provider = (body.provider || "").toLowerCase()
  if (!VALID.has(provider)) {
    return NextResponse.json({ ok: false, error: "provider must be 'openai' or 'anthropic_cli'" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const result = signOut(provider as CliProvider)
  appendAudit("llm_cli_signout", provider, result.ok ? "creds removed" : `failed: ${result.error}`, ip)
  return NextResponse.json(result)
}
