import { NextResponse, type NextRequest } from "next/server"
import { all, run } from "@/lib/db"
import { appendAudit } from "@/lib/repos/audit"
import { logPipeline } from "@/lib/repos/logs"
import { deleteDroplet } from "@/lib/digitalocean"
import { getSetting } from "@/lib/repos/settings"

export const runtime = "nodejs"

interface ServerRow {
  id: number
  name: string | null
  ip: string | null
  do_droplet_id: string | null
  sa_server_id: string | null
  sa_org_id: string | null
}

/**
 * Hard delete: destroy DO droplet + remove SA server reference + drop DB row.
 * Mirrors Flask api_delete_server. Requires `confirm_name` form field that
 * exactly matches the server's name (typed-name guard against fat-finger destroys).
 * Refuses if any domain still references this server.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const serverId = Number.parseInt(id, 10)
  if (!Number.isFinite(serverId)) {
    return NextResponse.json({ ok: false, error: "invalid server id" }, { status: 400 })
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const confirm = ((form?.get("confirm_name") as string | null) || "").trim()

  const row = all<ServerRow>("SELECT * FROM servers WHERE id = ?", serverId)[0]
  if (!row) {
    return NextResponse.json({ ok: false, error: "Server not found" }, { status: 404 })
  }

  const expected = row.name ?? ""
  if (confirm !== expected) {
    return NextResponse.json({
      ok: false,
      error:
        `Typed name doesn't match. Got '${confirm}', expected '${expected}'. ` +
        "Nothing was deleted.",
    }, { status: 400 })
  }

  const ref = (all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM domains WHERE server_id = ?", serverId,
  )[0]?.n) ?? 0
  if (ref > 0) {
    return NextResponse.json({
      ok: false,
      error: `Cannot delete — ${ref} domain(s) still hosted on this server. Delete or move those domains first.`,
    }, { status: 409 })
  }

  const label = row.name ?? `srv-${serverId}`

  // 1. DO droplet (best-effort — 404 means already gone, no need to abort)
  if (row.do_droplet_id) {
    try {
      await deleteDroplet(row.do_droplet_id)
      logPipeline(label, "server_teardown", "running",
        `DO droplet ${row.do_droplet_id} destroyed`)
    } catch (e) {
      logPipeline(label, "server_teardown", "warning",
        `DO delete: ${(e as Error).message}`)
    }
  }

  // 2. SA server record (best-effort)
  const saId = row.sa_server_id
  const saOrg = row.sa_org_id || getSetting("serveravatar_org_id") || ""
  const saTok = getSetting("serveravatar_api_key") || ""
  if (saId && saOrg && saTok) {
    try {
      const r = await fetch(
        `https://api.serveravatar.com/organizations/${saOrg}/servers/${saId}`,
        {
          method: "DELETE",
          headers: { Authorization: saTok, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        },
      )
      if (r.status >= 400) {
        logPipeline(label, "server_teardown", "warning",
          `SA server delete: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`)
      } else {
        logPipeline(label, "server_teardown", "running",
          `SA server ${saId} removed`)
      }
    } catch (e) {
      logPipeline(label, "server_teardown", "warning",
        `SA delete: ${(e as Error).message}`)
    }
  }

  // 3. Drop DB row
  run("DELETE FROM servers WHERE id = ?", serverId)
  logPipeline(label, "server_teardown", "completed",
    `Hard-deleted server #${serverId} (DO + SA + DB)`)

  appendAudit("server_destroy", String(serverId),
    `name=${expected} droplet=${row.do_droplet_id ?? ""} sa=${saId ?? ""}`, ip)
  return NextResponse.json({
    ok: true,
    message: `Server '${label}' destroyed — droplet stopped billing, SA cleaned, row dropped.`,
  })
}
