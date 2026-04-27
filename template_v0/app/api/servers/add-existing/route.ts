import { NextResponse, type NextRequest } from "next/server"
import { addServer, updateServer } from "@/lib/repos/servers"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Manual server registration — for hardware you already provisioned by hand
 * or a server SA's UI created. If `sa_server_id` is set the server is marked
 * 'ready' immediately; otherwise still 'ready' but with no SA link.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const name = ((form?.get("name") as string | null) || "").trim()
  const serverIp = ((form?.get("ip") as string | null) || "").trim()
  const saServerId = ((form?.get("sa_server_id") as string | null) || "").trim()
  if (!name || !serverIp) {
    return NextResponse.json({ ok: false, error: "name and ip are required" }, { status: 400 })
  }
  const sid = addServer(name, serverIp)
  if (saServerId) {
    updateServer(sid, { sa_server_id: saServerId, status: "ready" })
  } else {
    updateServer(sid, { status: "ready" })
  }
  appendAudit("server_add_existing", String(sid), `name=${name} ip=${serverIp}`, ip)
  return NextResponse.json({ ok: true, id: sid, message: `Server added: ${name} (${serverIp})` })
}
