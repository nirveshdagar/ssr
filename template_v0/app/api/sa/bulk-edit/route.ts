import { NextResponse, type NextRequest } from "next/server"
import { bulkEditIndex, type BulkEditOp, type BulkEditTarget } from "@/lib/sa-control"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

/**
 * Bulk edit /public_html/index.php across many apps.
 *
 * POST JSON {
 *   targets: [{ domain, server_ip }, …],
 *   op: { kind: "insert_top"|"append_end"|"search_replace"|"replace_line", … },
 *   dry_run?: boolean,
 *   concurrency?: number   // 1..10 (default 5)
 * }
 *
 * Per-target result is returned in `items`. Errors don't abort the batch —
 * they're collected and surfaced. Each write does its own .bak backup.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let body: {
    targets?: BulkEditTarget[]
    op?: BulkEditOp
    dry_run?: boolean
    concurrency?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "expected JSON body" }, { status: 400 })
  }

  const targets = (body.targets ?? []).filter(
    (t): t is BulkEditTarget => !!t && typeof t.domain === "string" && typeof t.server_ip === "string",
  )
  if (targets.length === 0) {
    return NextResponse.json({ ok: false, error: "no targets provided" }, { status: 400 })
  }
  if (!body.op || !["insert_top", "append_end", "search_replace", "replace_line", "delete_top"].includes(body.op.kind)) {
    return NextResponse.json({ ok: false, error: "op.kind must be one of insert_top|append_end|search_replace|replace_line|delete_top" }, { status: 400 })
  }

  // Op-specific validation
  if (body.op.kind === "insert_top" || body.op.kind === "append_end") {
    if (!body.op.code || typeof body.op.code !== "string") {
      return NextResponse.json({ ok: false, error: "code required for insert_top / append_end" }, { status: 400 })
    }
  } else if (body.op.kind === "search_replace") {
    if (!body.op.find || typeof body.op.find !== "string") {
      return NextResponse.json({ ok: false, error: "find required for search_replace" }, { status: 400 })
    }
    if (typeof body.op.replace !== "string") {
      return NextResponse.json({ ok: false, error: "replace must be string for search_replace" }, { status: 400 })
    }
  } else if (body.op.kind === "replace_line") {
    if (typeof body.op.line !== "number" || body.op.line < 1) {
      return NextResponse.json({ ok: false, error: "line must be >= 1 for replace_line" }, { status: 400 })
    }
    if (typeof body.op.replace !== "string") {
      return NextResponse.json({ ok: false, error: "replace must be string for replace_line" }, { status: 400 })
    }
  }

  try {
    const result = await bulkEditIndex(targets, body.op, {
      dryRun: !!body.dry_run,
      concurrency: body.concurrency,
    })
    appendAudit(
      "sa_bulk_index_edit", "",
      `op=${body.op.kind} targets=${targets.length} ok=${result.succeeded} failed=${result.failed} ` +
      `unchanged=${result.unchanged} dry_run=${!!body.dry_run}`,
      ip,
    )
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
