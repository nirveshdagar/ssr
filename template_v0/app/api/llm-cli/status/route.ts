import { NextResponse, type NextRequest } from "next/server"
import { getCliStatus, type CliProvider } from "@/lib/llm-cli"

export const runtime = "nodejs"

const VALID = new Set<string>(["openai", "anthropic_cli"])

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url)
  const provider = (url.searchParams.get("provider") || "").toLowerCase()
  if (!VALID.has(provider)) {
    return NextResponse.json({ error: "provider must be 'openai' or 'anthropic_cli'" }, { status: 400 })
  }
  return NextResponse.json(getCliStatus(provider as CliProvider))
}
