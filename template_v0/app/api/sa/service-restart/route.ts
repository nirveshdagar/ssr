import { NextResponse, type NextRequest } from "next/server"
import { restartApache, restartPhpFpm } from "@/lib/sa-control"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Reload web server / restart PHP-FPM via SSH.
 *
 * POST { server_ip, service }   service ∈ "web" | "php-fpm" | "both"
 *
 * Strict: only the two predefined commands wrapped by lib/sa-control —
 * no arbitrary command-execution surface.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  const form = await req.formData().catch(() => null)
  const serverIp = ((form?.get("server_ip") as string | null) || "").trim()
  const service = ((form?.get("service") as string | null) || "both").trim()
  if (!serverIp) {
    return NextResponse.json({ ok: false, error: "server_ip required" }, { status: 400 })
  }
  if (!["web", "php-fpm", "both"].includes(service)) {
    return NextResponse.json({ ok: false, error: "service must be web | php-fpm | both" }, { status: 400 })
  }

  const out: { service: string; ok: boolean; output: string }[] = []
  try {
    if (service === "web" || service === "both") {
      const r = await restartApache(serverIp)
      out.push({ service: "apache/nginx", ok: r.ok, output: r.output.slice(0, 200) })
    }
    if (service === "php-fpm" || service === "both") {
      const r = await restartPhpFpm(serverIp)
      out.push({ service: "php-fpm", ok: r.ok, output: r.output.slice(0, 200) })
    }
    const allOk = out.every((o) => o.ok)
    appendAudit(
      "sa_service_restart", serverIp,
      `service=${service} ok=${allOk} ${out.map((o) => o.service + ":" + (o.ok ? "ok" : "fail")).join(" ")}`,
      ip,
    )
    return NextResponse.json({
      ok: allOk, results: out,
      message: allOk ? "All requested services restarted" : "Some services failed — see results",
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
