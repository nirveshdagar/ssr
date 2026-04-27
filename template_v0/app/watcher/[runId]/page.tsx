import { notFound } from "next/navigation"
import Link from "next/link"
import { getPipelineRun, getStepRuns } from "@/lib/repos/steps"
import { AppShell } from "@/components/ssr/app-shell"
import { RunDetailClient } from "./client"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ runId: string }>
}

/**
 * Server-rendered run detail. Mirrors the per-run drill-down inside the
 * Run-history modal on /domains, but as a dedicated bookmarkable page so an
 * operator can paste the URL into Slack / a bug ticket.
 *
 * Each step's `artifact_json` ships down once on the server; the client
 * island only needs interactivity (collapse + copy).
 */
export default async function RunDetailPage({ params }: PageProps) {
  const { runId } = await params
  const id = Number.parseInt(runId, 10)
  if (!Number.isFinite(id) || id <= 0) notFound()
  const run = getPipelineRun(id)
  if (!run) notFound()
  const steps = getStepRuns(id)

  const startedHuman = run.started_at
    ? new Date(run.started_at * 1000).toLocaleString()
    : "—"
  const endedHuman = run.ended_at
    ? new Date(run.ended_at * 1000).toLocaleString()
    : "—"
  const dur = run.started_at && run.ended_at
    ? `${Math.round(run.ended_at - run.started_at)}s`
    : run.started_at ? "running" : "—"

  return (
    <AppShell
      title={`Run #${run.id}`}
      description={`${run.domain} · status ${run.status} · started ${startedHuman} · duration ${dur}`}
      breadcrumbs={[
        { label: "Watcher", href: "/watcher" },
        { label: `Run #${run.id}` },
      ]}
      accent="watcher"
    >
      <div className="mb-3 text-small">
        <Link
          href={`/domains/${encodeURIComponent(run.domain)}`}
          className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          title={`Open the full domain detail page for ${run.domain}`}
        >
          ← {run.domain}
        </Link>
      </div>

      <RunDetailClient
        run={run}
        steps={steps}
        startedHuman={startedHuman}
        endedHuman={endedHuman}
        dur={dur}
      />
    </AppShell>
  )
}
