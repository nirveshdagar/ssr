# Production-readiness audit — consolidated summary
**Date**: 2026-04-30
**Scope**: template_v0/ (Next.js 16, better-sqlite3, iron-session, multi-API orchestrator)
**Source reports**: `security.md`, `data-concurrency.md`, `failure-observability.md`, `validation-tests-deps.md`

## Headline numbers

| Severity | Count | What it means |
|---|---|---|
| **P0** | 5 | Production blockers — must fix before any prod traffic |
| **P1** | 24 | Must fix before prod (high-likelihood failure / missing core defense) |
| **P2** | 24 | Should fix (defense-in-depth, brittleness) |
| **P3** | 13 | Nits / polish |
| **Total** | **66** | |

## Verdict

The codebase has **strong fundamentals**: parameterized SQL throughout, centralized auth gating, encrypted-at-rest design (Fernet), HMR-safe globals, per-step + per-slot locks, idempotent CF/SA creates, primary→backup token failover for DO/SA, supervised live-checker, type strictness clean (zero `as any`).

The **gaps that block prod** are:

1. **Money safety** — DO creates aren't idempotent on retry, and 8 bulk endpoints have no array-length cap. One CSRF or one copy-paste accident → multi-thousand-dollar bill.
2. **Data durability** — no DB or Fernet-key backup anywhere. Single disk failure = total loss.
3. **Process lifecycle** — no SIGTERM/uncaughtException handler. Every container restart can corrupt mid-step state.
4. **Alerting** — `notifyPipelineFailure` is fully implemented but **has zero call sites**. Failures are silent.
5. **Secrets exposure** — `cf_keys.api_key` is plaintext at rest, and `GET /api/settings` returns every secret in plaintext to any authed cookie. One stolen cookie = full credential exfil.
6. **CSRF** — `sameSite: lax` cookie + no CSRF token + no Origin check. Every destructive route is cross-site exploitable.

None of these are deep architectural problems. All have ~small, well-scoped fixes.

---

## P0 — Production blockers (5)

### [P0-1] DO droplet creation not idempotent on retry
- `lib/digitalocean.ts:408-467` (createDroplet)
- Timeout-then-retry can create a second billed droplet. CF and SA have idempotent paths; DO doesn't.
- **Fix**: list-by-tag pre-POST; on POST throw, list-by-name to recover droplet ID rather than treating as clean fail.

### [P0-2] Bulk endpoints accept unbounded arrays
- `app/api/ai-generator/queue`, `domains/run-bulk`, `domains/run-bulk-sequential`, `domains/bulk-migrate`, `domains/bulk-delete`, `cf-keys/bulk-add`, `cf-keys/bulk-delete`, `cf-keys/[id]/bulk-set-ip`, `cf-keys/[id]/bulk-set-settings`
- Single authed POST can enqueue 10k droplet provisions or hold a route open for hours hammering CF.
- **Fix**: `MAX_BULK = 1000` (or 200 for cf-keys/bulk-add since it serially calls CF), 413 on excess. Mirror existing `bulk-dns-csv` pattern.

### [P0-3] No DB or Fernet-key backup anywhere
- repo-wide — no `db.backup()`, no `VACUUM INTO`, no rotation script, no docs.
- One disk failure / `rm` typo / bad migration = total loss including every encrypted secret.
- **Fix**: `lib/boot.ts` daily hook → `db.backup("data/backups/ssr-YYYYMMDD.db")`, copy `.ssr_secret_fernet` alongside, keep N=7. Restore runbook in DEPLOY.md.

### [P0-4] No SIGTERM / uncaughtException handler
- repo-wide — zero `process.on(...)` registrations.
- Container exit kills workers mid-step-6 (DO created + SA mid-install) → SSL half-applied, two installers race on next boot.
- **Fix**: `instrumentation.ts` SIGTERM handler that sets a stop flag (checked at every step boundary), calls `jobs.stopPool()` + `live-checker.stop()`, waits up to 30s for in-flight handlers, exits. Plus `uncaughtException` / `unhandledRejection` loggers.

### [P0-5] `notifyPipelineFailure` is dead code — pipeline failures are silent
- `lib/notify.ts:360-371` defines it; **zero call sites**. `pipelineWorkerImpl` outermost catch only writes to `pipeline_log`.
- At 50-fan-out scale, failures are invisible until operator manually browses dashboard.
- **Fix**: in `pipelineWorkerImpl` outer catch, after `retryable_error` flip, fire `void notifyPipelineFailure(domain, currentStep, err.message)`. Same for CF-pool-exhausted and DO-all-tokens-failed paths.

---

## P1 — Must fix before prod (24)

Grouped by remediation cluster so each cluster can ship as one wave.

### Cluster A — Secrets exposure (3)
- **[P1-A1]** `cf_keys.api_key` stored plaintext (`lib/repos/cf-keys.ts:30`). Mirror what `cf-ai-keys.ts` already does — encrypt + boot migration.
- **[P1-A2]** `GET /api/settings` returns all secrets unredacted (`app/api/settings/route.ts:63-83`). Return `*_set` booleans / last-4 masks.
- **[P1-A3]** Boot self-bootstraps Fernet key if missing (silent credential loss in prod). In NODE_ENV=production, refuse to auto-gen if encrypted rows already exist.

### Cluster B — CSRF + cookie (1, but big)
- **[P1-B1]** No CSRF token, `sameSite: "lax"`, no Origin check (`lib/auth-config.ts:40`). Flip to `sameSite: "strict"` (no SSO so safe) + add Origin header check in middleware. ~20 LOC.

### Cluster C — Auth/audit hygiene (3)
- **[P1-C1]** Login route 500-on-no-password is a fingerprint oracle (`app/api/auth/login/route.ts:30`). Return generic 401.
- **[P1-C2]** Login success/failure not in `audit_log` (separate `login_attempts` table only). Add `appendAudit("login_success"|"login_failure", ...)`.
- **[P1-C3]** Pipeline-launching routes not audited (run-pipeline, run-from/[step], run-bulk, run-bulk-sequential). `appendAudit("pipeline_run", ...)` everywhere.

### Cluster D — Shell injection / RCE (2)
- **[P1-D1]** `customModel` → `spawn(..., { shell: true })` on Windows = RCE (`lib/llm-cli.ts:71-76`). Validate via strict allowlist regex AND drop `shell: true` (call `.cmd` shim directly).
- **[P1-D2]** CSV import doesn't validate domain shape (`app/api/domains/import/route.ts:64`). Reuse `DOMAIN_SHAPE` regex from ai-generator/queue.

### Cluster E — Env-name drift (1)
- **[P1-E1]** Code reads `SSR_SESSION_SECRET`; `.env.example` + `DEPLOY.md` say `SSR_SESSION_PASSWORD`. Pick one (recommend `_PASSWORD` since iron-session uses that term), align all three.

### Cluster F — External API resilience (5)
- **[P1-F1]** Cloudflare REST has no `AbortSignal.timeout` (`lib/cloudflare.ts:71-110, 386-398`). Hung TCP = pinned forever. Add 30s timeout.
- **[P1-F2]** Spaceship has no timeouts, no retries, no failover token (`lib/spaceship.ts`). Add 30s timeouts + 2-attempt linear backoff. Pre-purchase `getDomainInfo()` to dodge double-charge.
- **[P1-F3]** `/api/health` returns hardcoded `{status:"ok"}` (`app/api/health/route.ts`). Add SELECT 1, vault-key existence, worker-count check. Optionally split live vs ready.
- **[P1-F4]** LLM provider calls `(await res.json())` without text-first parse (`lib/website-generator.ts:611, 708, 740`). Provider truncation = SyntaxError, no retry. Use `safeJson` pattern + 1-2 retries.
- **[P1-F5]** `pipeline.full` enqueued with `maxAttempts=1`. Transient SQLite-locked or 502 = terminal failure until auto-heal claims it. Pass `maxAttempts=3` everywhere.

### Cluster G — Job/queue crash recovery (3)
- **[P1-G1]** Job pool only calls `recoverOrphans()` at boot (`lib/jobs.ts:233`). Worker dying mid-job leaves row stuck `running` forever. Add 5-min sweeper.
- **[P1-G2]** `attempt_count` increments on CLAIM, recovery checks `>= max_attempts`, so `max_attempts=1` jobs never retry after crash (`lib/jobs.ts:152, 100-138`). Increment on FAILURE not claim.
- **[P1-G3]** Auto-heal tick failures only logged via `pipeline_log` warning, never paged (`lib/auto-heal.ts:421-451`). On outer catch, call `notify(...)` with dedupeKey + `appendAudit`.

### Cluster H — Concurrency / data drift (3)
- **[P1-H1]** `assignCfKeyToDomain` reads existing-domain row OUTSIDE BEGIN, leaks slot on race (`lib/cf-key-pool.ts:127-167`). Move read inside BEGIN; guard UPDATE with `WHERE cf_key_id IS NULL`.
- **[P1-H2]** `deleteCfKey` reference-check + DELETE not transactional (`lib/repos/cf-keys.ts:62-67`). Wrap in BEGIN IMMEDIATE OR rely on real FK with ON DELETE RESTRICT.
- **[P1-H3]** FK declarations exist in test schema but prod schema is Flask-owned — actual enforcement unverified. Audit Flask's `init_db` for FK clauses; document.

### Cluster I — Untested critical code (3)
- **[P1-I1]** `loginThrottleCheckAndReserve` race-fix has no test (`lib/login-throttle.ts:44`). Add concurrent-call test asserting exactly MAX_PER_WINDOW pass.
- **[P1-I2]** `encryptExistingAiTokens` boot migration has no test (`lib/repos/cf-ai-keys.ts:160`). Mixed-rows seed + double-run idempotency assertion.
- **[P1-I3]** `pipeline_log` writes have no length cap; CF/SA error bodies stuff multi-KB rows. Cap inside `logPipeline()` itself (≤2 KiB).

### Cluster J — CF AI pool retry cap (1)
- **[P1-J1]** Hardcoded `for attempt < 6` cap in `lib/website-generator.ts:644` while v9_state encourages stacking many CF accounts. Loop until `getNextAiKey(tried)` itself throws.

---

## P2 + P3 (37 findings)

Deferred from prod-readiness gate. Full detail in the four lens reports. Highlights:

**P2 worth flagging now**:
- No security headers (`next.config.mjs` — add CSP / HSTS / X-Frame-Options)
- `server_ip` not validated as known-fleet (SSH/SFTP to arbitrary IPs)
- Open redirect in `/login?next=`
- `x-forwarded-for` taken raw → throttle bypass + audit forgery
- step6/step9/migration multi-write blocks lacking transactions
- live-checker streak counters per-process (race with auto-heal)
- audit_log + pipeline_log unbounded growth (no rotation)
- No prom-client / metrics

**P3 worth flagging now**:
- `tsconfig.json` should add `noUncheckedIndexedAccess`
- `instrumentation.ts` swallows all `registerHandler` errors silently
- Settings POST audit doesn't list which fields changed

---

## Recommended fix waves

| Wave | Clusters | Scope | Why first |
|---|---|---|---|
| **1 — Money + data safety** | P0-1, P0-2, P0-3 | DO idempotency, bulk caps, daily DB backup | Prevents catastrophic loss; small diffs |
| **2 — Lifecycle + alerting** | P0-4, P0-5, Cluster G | SIGTERM handler, wire `notifyPipelineFailure`, sweeper | Makes failures visible; one cohesive surface |
| **3 — Auth surface** | Cluster A, B, C, E | Encrypt cf_keys, redact GET /settings, sameSite strict, audit logins, fix env name | Defense-in-depth on the most exposed surface |
| **4 — Shell + RCE hardening** | Cluster D | Allowlist customModel, drop `shell:true`, validate CSV domain shape | Closes the only RCE path |
| **5 — Resilience** | Cluster F, H, J | CF/Spaceship timeouts, /api/health real probe, LLM safeJson, retry caps, race fixes | Reduces 3am pages |
| **6 — Tests** | Cluster I | Tests for the 3 critical-but-untested pieces | Lock in invariants for the above waves |

Estimated effort, P0 + P1 only: **~12-18 hours** of focused work, splittable across waves. Each wave is committable independently and runs the typecheck-and-test loop cleanly.

P2 + P3 sweep: separate follow-up, ~6-10 hours.
