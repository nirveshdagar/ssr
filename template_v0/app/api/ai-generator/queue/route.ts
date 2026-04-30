import { NextResponse, type NextRequest } from "next/server"
import { addDomain, listDomains } from "@/lib/repos/domains"
import {
  runFullPipeline,
  runSequentialBulkPipeline,
  type BulkRunResult,
} from "@/lib/pipeline"
import { appendAudit } from "@/lib/repos/audit"

export const runtime = "nodejs"

interface QueueResult {
  added: string[]
  already_present: string[]
  invalid: string[]
  enqueued: string[]
  job_id?: number | null
  job_ids?: number[]
}

const DOMAIN_SHAPE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

/**
 * One-shot operator endpoint for the /ai-generator page. Accepts a list of
 * domain names (single or multiple), creates DB rows for any that don't
 * exist yet, and queues them through the pipeline:
 *   - 1 domain  → fires `runFullPipeline` (parallel-friendly path)
 *   - N domains → fires `runSequentialBulkPipeline` so they process ONE AT
 *     A TIME (per the spec — avoids parallel overload + lets a 50-domain
 *     batch trickle through without burning all CF / SA / LLM quota at
 *     once)
 *
 * Body (JSON):
 *   { domains: string[], skip_purchase?: bool, custom_provider?: string,
 *     custom_model?: string, custom_prompt?: string }
 */
export async function POST(req: NextRequest): Promise<Response> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null
  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: "expected JSON body" }, { status: 400 })
  }
  const raw = body.domains
  if (!Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "domains must be an array of strings" }, { status: 400 })
  }
  // Normalize, dedup, validate.
  const seen = new Set<string>()
  const valid: string[] = []
  const invalid: string[] = []
  for (const x of raw) {
    let d = String(x ?? "").trim().toLowerCase()
    d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")
    if (!d) continue
    if (seen.has(d)) continue
    seen.add(d)
    if (!DOMAIN_SHAPE.test(d)) {
      invalid.push(d)
      continue
    }
    valid.push(d)
  }
  if (valid.length === 0) {
    return NextResponse.json({
      ok: false,
      error: invalid.length
        ? `No valid domains (${invalid.length} rejected by shape check: ${invalid.slice(0, 3).join(", ")})`
        : "No domains supplied",
      invalid,
    }, { status: 400 })
  }

  // Insert any that don't already exist; addDomain is idempotent so we just
  // call it for everything and bookkeep what was new vs already there.
  const existing = new Set(listDomains().map((d) => d.domain.toLowerCase()))
  const added: string[] = []
  const alreadyPresent: string[] = []
  for (const d of valid) {
    if (existing.has(d)) {
      alreadyPresent.push(d)
    } else {
      addDomain(d)
      added.push(d)
    }
  }

  const skipPurchase = body.skip_purchase === true || body.skip_purchase === "on"
  const trim = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined
    const t = v.trim()
    return t || undefined
  }
  const customProvider = trim(body.custom_provider)
  const customModel = trim(body.custom_model)
  const customPrompt = trim(body.custom_prompt)

  // Single domain → full pipeline, parallel-eligible.
  // Multi domain → sequential bulk (one-at-a-time per the spec).
  const result: QueueResult = {
    added, already_present: alreadyPresent, invalid, enqueued: [],
  }
  if (valid.length === 1) {
    const id = runFullPipeline(valid[0], {
      skipPurchase,
      customProvider, customModel, customPrompt,
    })
    if (id != null) {
      result.enqueued.push(valid[0])
      result.job_id = id
    }
  } else {
    const bulk: BulkRunResult = runSequentialBulkPipeline(valid, {
      skipPurchase, customProvider, customModel,
    })
    result.enqueued = bulk.eligible_domains
    result.job_id = bulk.job_id
    result.job_ids = bulk.job_ids
    // NOTE: customPrompt is NOT honored on the bulk path right now —
    // pipeline.bulk's payload doesn't carry it. Per-domain custom briefs
    // need the parallel `runBulkPipeline` (one job per domain) which DOES
    // thread it. Surface this so the operator isn't surprised:
    if (customPrompt) {
      // best-effort warning in the response; doesn't fail the call
      ;(result as unknown as { warning?: string }).warning =
        "custom_prompt is per-call; on the sequential bulk path it does NOT apply to siblings. " +
        "Use the parallel /api/domains/run-bulk path if you want every domain to get the same brief."
    }
  }

  appendAudit(
    "ai_generator_queue", "",
    `domains=${valid.length} added=${added.length} enqueued=${result.enqueued.length} ` +
    `provider=${customProvider ?? ""} model=${customModel ?? ""}`,
    ip,
  )
  return NextResponse.json({
    ok: true, ...result,
    message:
      `${valid.length} domain(s) accepted: ${added.length} new, ${alreadyPresent.length} already tracked, ` +
      `${result.enqueued.length} enqueued for pipeline run` +
      (invalid.length ? `; ${invalid.length} rejected` : ""),
  })
}
