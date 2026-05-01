import { NextResponse, type NextRequest } from "next/server"
import { installCli, type CliProvider } from "@/lib/llm-cli"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

const VALID = new Set<string>(["openai", "anthropic_cli"])

/** Blocking install — returns when `npm i -g <pkg>` exits. UI shows a
 *  spinner while waiting; typically 10-30s on a warm npm cache. */
export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { provider?: string }
  const provider = (body.provider || "").toLowerCase()
  if (!VALID.has(provider)) {
    return NextResponse.json({ ok: false, error: "provider must be 'openai' or 'anthropic_cli'" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const result = await installCli(provider as CliProvider)
  appendAudit(
    "llm_cli_install",
    provider,
    result.ok ? "installed" : `failed: ${result.error?.slice(0, 200) ?? "unknown"}`,
    ip,
  )
  return NextResponse.json(result)
}
