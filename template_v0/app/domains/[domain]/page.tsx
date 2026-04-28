import { notFound } from "next/navigation"
import Link from "next/link"
import { getDomain } from "@/lib/repos/domains"
import { listServers } from "@/lib/repos/servers"
import { listCfKeysWithPreview } from "@/lib/repos/cf-keys"
import { getSteps } from "@/lib/repos/steps"
import { listPipelineLogs } from "@/lib/repos/logs"
import { AppShell } from "@/components/ssr/app-shell"
import { DomainDetailClient } from "./client"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ domain: string }>
}

/**
 * Server-rendered domain detail. Pulls the row + joined server/cf-key info +
 * step_tracker snapshot + recent logs in one DB pass, then hands a small
 * client island the bits that need live polling (heartbeat + step status).
 *
 * Mirrors what Flask's per-row Watcher + Run history modal exposed, but as a
 * full bookmarkable page. Use the back-to-list breadcrumb to return to the
 * filtered domains view.
 */
export default async function DomainDetailPage({ params }: PageProps) {
  const { domain: rawDomain } = await params
  const domain = decodeURIComponent(rawDomain)
  const rowRaw = getDomain(domain)
  if (!rowRaw) notFound()

  // node:sqlite hands back null-prototype rows, which Next.js 16's RSC
  // serializer rejects across the server→client boundary. Shallow-clone
  // every row that crosses into the client island to make them plain
  // {} objects.
  const row = { ...rowRaw }
  const serverRaw = row.server_id
    ? listServers().find((s) => s.id === row.server_id) ?? null
    : null
  const server = serverRaw ? { ...serverRaw } : null
  const cfKeyRaw = row.cf_key_id
    ? listCfKeysWithPreview().find((k) => k.id === row.cf_key_id) ?? null
    : null
  const cfKey = cfKeyRaw ? { ...cfKeyRaw } : null
  const steps = getSteps(domain).map((s) => ({ ...s }))
  const recentLogs = listPipelineLogs({ domain, limit: 50 }).map((l) => ({ ...l }))

  return (
    <AppShell
      title={domain}
      description={`status: ${row.status} · server: ${server?.name ?? "—"} · CF: ${cfKey?.alias ?? cfKey?.email ?? "—"}`}
      breadcrumbs={[
        { label: "Domains", href: "/domains" },
        { label: domain },
      ]}
      accent="domains"
    >
      <div className="mb-3 text-small">
        <Link
          href="/domains"
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          title="Back to the full domains list"
        >
          ← Back to all domains
        </Link>
      </div>

      <DomainDetailClient
        domain={domain}
        row={row}
        server={server}
        cfKey={cfKey}
        initialSteps={steps}
        initialLogs={recentLogs}
      />
    </AppShell>
  )
}
