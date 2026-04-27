import { NextResponse, type NextRequest } from "next/server"
import { getSetting } from "@/lib/repos/settings"

export const runtime = "nodejs"

interface ProbeResult {
  configured: boolean
  ok: boolean
  email: string
  status?: string
  droplet_limit?: number
  error: string
}

async function probe(token: string): Promise<ProbeResult> {
  if (!token) {
    return { configured: false, ok: false, email: "", error: "not provided" }
  }
  try {
    const r = await fetch("https://api.digitalocean.com/v2/account", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (r.ok) {
      const j = (await r.json()) as { account?: { email?: string; status?: string; droplet_limit?: number } }
      const a = j.account ?? {}
      return {
        configured: true, ok: true,
        email: a.email ?? "?",
        status: a.status ?? "?",
        droplet_limit: a.droplet_limit,
        error: "",
      }
    }
    return {
      configured: true, ok: false, email: "",
      error: `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`,
    }
  } catch (e) {
    return {
      configured: true, ok: false, email: "",
      error: `${(e as Error).name}: ${(e as Error).message}`,
    }
  }
}

/**
 * Probe both DO tokens. Form may pass `do_api_token` / `do_api_token_backup`
 * to test current form values without saving first; otherwise falls back to
 * stored DB values.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData().catch(() => null)
  const primary = ((form?.get("do_api_token") as string | null) || "").trim() ||
                  (getSetting("do_api_token") || "").trim()
  const backup = ((form?.get("do_api_token_backup") as string | null) || "").trim() ||
                 (getSetting("do_api_token_backup") || "").trim()
  const [primaryRes, backupRes] = await Promise.all([probe(primary), probe(backup)])
  return NextResponse.json({ primary: primaryRes, backup: backupRes })
}
