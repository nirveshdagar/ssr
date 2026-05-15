# Failure modes + observability audit — 2026-04-30

**Verdict**: 24 findings (3 P0 / 9 P1 / 7 P2 / 5 P3). The pipeline itself is well-defended with per-step locks, primary→backup token failover (DO/SA), idempotent CF-zone + SA-app creates, and supervisor-restarted live-checker — but 5 production-grade gaps remain: DO droplet creates are NOT idempotent on retry, Spaceship has no timeouts/retries (purchase + setNameservers), the only `/api/health` returns a hard-coded `ok` (no DB probe), there is no SIGTERM/SIGINT or uncaughtException handler anywhere, and pipeline failures never trigger `notifyPipelineFailure` despite the helper being wired (silent failure for the operator).

## P0 — Production blockers

### [P0] DO droplet creation is not idempotent — a retry after timeout creates a second billed droplet
**File**: `template_v0/lib/digitalocean.ts:408-467` (`createDroplet`); called from `template_v0/lib/pipeline.ts:868` (step 6)
**Issue**: `doRequest("POST", "/droplets", …)` uses a 60 s timeout with no client-side request-id, no name-collision check, and no post-failure reconciliation. If DO actually created the droplet but the response is dropped (slow network, our 60 s `AbortSignal.timeout` fires, partner-token failover trips on a 5xx after the first token already created one), the worker raises and the operator clicks "Run from here" → step 6 fires a second POST with the same `tags: ["ssr-server"]` and (possibly) the same name, yielding two billed droplets. CF zone create (`cloudflare.ts:472-494`) and SA app create (`pipeline.ts:927-953`) both handle the analogous "already exists" code path and become idempotent — DO does not. The cost-cap (`max_droplets_per_hour`) only stops repeat calls; it does not deduplicate.
**Why it matters**: At 50-fan-out scale, a single CF outage that 504s mid-create would silently double the bill for that batch. Discovery latency = whenever the next sweep runs (the `orphanDropletSweep` boot hook *reports* but does NOT auto-destroy — see `lib/boot.ts:83-114`).
**Suggested fix**: Before POST, list droplets by `tag_name=ssr-server` and reject if the requested name is already present; AND if the POST throws after the request was sent, list-by-name to recover the droplet ID instead of treating it as a clean failure. (DO doesn't accept idempotency keys but does enforce unique droplet names within a region — exploit that.)

### [P0] No SIGTERM / SIGINT handler — in-flight pipelines and DB writes are killed mid-step
**File**: nowhere (searched whole repo for `process.on('SIGTERM` / `SIGINT` / `uncaughtException` / `unhandledRejection` — zero matches)
**Issue**: When the runtime receives SIGTERM (Docker stop, k8s rolling deploy, systemctl restart, Render redeploy), Node exits in <1 s. Any worker mid-step-6 (DO droplet just created, SA install one-liner just executed via SSH) leaves the row in `step_tracker` at `running` with no resolution. `jobs.recoverOrphans()` runs at boot and re-queues — that handles the job-table side, but each pipeline is at most-once at the API level: a step-6 SSH that already ran the install command + a re-queued job will run it again, racing against the SA agent that's mid-installation. The watcher-side `migrating` set in `live-checker.ts:35` and the in-flight slot lock in `pipeline.ts:79` are pure in-memory state — both wipe on restart.
**Why it matters**: Real-world impact: every deploy has a small chance of leaving an SSL install half-applied (cert files written, apache reload not run yet) or two SA agent installers fighting each other. Symptoms: domains stuck at `retryable_error` with cryptic "apache reload returned 1" messages.
**Suggested fix**: Add a graceful-shutdown handler in `instrumentation.ts` that (a) sets a global stop flag that `pipeline.ts` `pipelineWorkerImpl` checks at every step boundary just like `checkCancel`, (b) calls `jobs.stopPool()` and `live-checker.stop()`, (c) waits up to 30 s for in-flight handlers to complete, then exits. Also add `process.on('uncaughtException', …)` and `process.on('unhandledRejection', …)` that log via `logPipeline` and re-throw — currently a thrown rejection in a fire-and-forget `void someAsync()` would crash the runtime with no audit trail.

### [P0] Pipeline failures never call `notifyPipelineFailure` — operator only sees them by manually browsing logs
**File**: `template_v0/lib/pipeline.ts:637-644` ("notify hooks land when modules/notify is ported" comment is now stale — `lib/notify.ts:360-371` defines `notifyPipelineFailure` but nothing imports it)
**Issue**: The pipeline catch-all in `pipelineWorkerImpl` writes a `logPipeline(... "failed", ...)` row and flips status to `retryable_error`, but never invokes the notifier. Same for step-2 CF-pool exhaustion (`pipeline.ts:737-741`), step-6 DO-all-tokens-failed (`pipeline.ts:885-891`) — all silent. `notify-pipeline-failure` is fully implemented (Telegram/email/SMS/WhatsApp with 10 min dedupe) but has zero call sites. `notifyServerDead` is wired in `live-checker.ts:212`; only that one path ever pages an operator.
**Why it matters**: At 50-fan-out scale, the operator may not check the dashboard for hours — by which point the auto-heal sweeper has retried the same domain 5x (within the 24h cap) and given up silently. The whole alerting subsystem exists but is dark.
**Suggested fix**: In `pipelineWorkerImpl`'s outermost catch, after marking `retryable_error`, fire `void notifyPipelineFailure(domain, currentStep, err.message)`. Also fire it when CF-pool-exhausted / DO-all-tokens-failed — those are exactly the "operator must intervene" cases the helpers were written for.

## P1 — Must fix before prod

### [P1] Cloudflare REST has no HTTP timeout
**File**: `template_v0/lib/cloudflare.ts:71-110` (`cfRequest`), `:386-398` (`rawCfPost`)
**Issue**: The `fetch` call passes `method`, `headers`, `body` only — no `signal: AbortSignal.timeout(...)`. CF normally responds in <500 ms, but if the connection hangs (kept-alive pool stale entry, CF edge in degraded state, our outbound NAT box dropping the SYN-ACK), the worker pegs forever. The retry loop at `:84-107` retries on 429/5xx but a hung TCP connection never reaches that branch. Every other API client in the codebase (DO, SA, Spaceship-preflight, notify, migration) has explicit timeouts — CF is the lone outlier and it's the API we hit *most*.
**Why it matters**: A single CF region brownout (which has happened multiple times in real CF history) would freeze all 50 fan-out pipelines mid-step-3/5/7/8 with no abort path; the heartbeat keeps writing `running` so auto-heal won't even pick it up as stuck.
**Suggested fix**: Add `signal: AbortSignal.timeout(30_000)` to the `fetch` calls in `cfRequest` and `rawCfPost`. Bonus: align with DO's 60 s create / 30 s read split.

### [P1] Spaceship registrar has no timeouts and no retries on 5xx — and no failover token
**File**: `template_v0/lib/spaceship.ts:63-67, 81-83, 136-140, 174-178, 211-215, 239-247, 254-257`
**Issue**: Every `fetch` is a bare `fetch(url, { headers, body })` with no signal, no retry. `purchaseDomain` is the worst case: it POSTs, gets a 202 back with an async-operation id, then polls every 5 s up to 120 s in `pollAsyncOperation` — that polling is also unguarded. A Spaceship 502 mid-purchase silently leaves us thinking the domain wasn't bought (we return `{ ok: false }`), but Spaceship's billing engine may have already charged. Unlike DO and SA, Spaceship has no backup-token concept — a single account suspension stalls every step-1 forever.
**Why it matters**: Step 1 + step 4 can hang the whole pipeline on a Spaceship blip. `purchaseDomain` returning `{ ok:false }` after a charge → operator manually marks `owned`, but the dashboard's bookkeeping shows we didn't buy → next bulk run buys it again. Double-purchase risk is real.
**Suggested fix**: Wrap every Spaceship `fetch` with `signal: AbortSignal.timeout(30_000)`. After 5xx/429, add 2-attempt linear backoff identical to the CF pattern. For purchase specifically: before issuing POST, call `getDomainInfo(domain)` to detect "already in account" and short-circuit.

### [P1] `/api/health` returns 200 unconditionally — no DB / disk / vault probe
**File**: `template_v0/app/api/health/route.ts:5-7`
**Issue**: Body is literally `NextResponse.json({ status: "ok" })`. It doesn't open the DB, doesn't read a setting, doesn't verify the Fernet key is loadable, doesn't check that the job pool is alive. A k8s liveness probe pointing here will report "healthy" even when the SQLite file is unreadable, the Fernet key is missing, and 0 workers are active (handlers fail with `No handler registered for kind=…` and jobs pile up).
**Why it matters**: Outages stay invisible to load balancers / k8s. Operators discover them via "why isn't my domain progressing?" — minutes-to-hours later than necessary.
**Suggested fix**: Run a cheap `SELECT 1`, count active job workers (compare against `defaultWorkers()`), check `existsSync(SSR_FERNET_KEY_PATH)` if set, return 200 only when all green; 503 + JSON detail otherwise. Optionally split into `/api/health/live` (process up) vs `/api/health/ready` (DB + workers + vault) — the standard k8s split.

### [P1] LLM provider calls swallow malformed JSON without retry
**File**: `template_v0/lib/website-generator.ts:611, 708, 740` (Anthropic / Gemini / OpenRouter / Moonshot branches)
**Issue**: `(await res.json()) as { ... }` — if the provider returns 200 with truncated/non-JSON body (happens occasionally on Anthropic quota throttling and OpenRouter on upstream-failure passthrough), this throws `SyntaxError: Unexpected token` and the whole step 9 fails with a confusing error. There's no fallback to `safeJson`-style parsing or a retry. Compare to `serveravatar.ts:173-181` which has `safeJson` exactly to dodge this. Cloudflare-pool path (`:644-684`) DOES retry on quota errors, but only for that one provider.
**Why it matters**: The user sees `LLM error: Unexpected token < in JSON at position 0` and the whole pipeline halts — masquerades as "the model hates this niche" when it's actually a transient upstream blip.
**Suggested fix**: Read body as text first, try JSON.parse, on failure throw a descriptive `LLMResponseMalformed: provider=… status=… body-head=…`. Add 1-2 retries with backoff for these specific cases (the cloudflare_pool path is the model — extend to the other branches).

### [P1] `pipeline.full` jobs are configured with `maxAttempts=1` — no automatic retry on transient
**File**: `template_v0/lib/pipeline.ts:214-223, 273-282, 329-336` (all callers omit the `maxAttempts` arg, so `enqueueJob` defaults it to 1 in `lib/jobs.ts:70`)
**Issue**: A transient SQLite "database is locked" or a single Anthropic 502 inside a step throws → `runOne` (`jobs.ts:185-209`) sees `attempt_count >= max_attempts` immediately and marks the job `failed`. The pipeline-level `retryable_error` status path + auto-heal sweeper compensate over a 30 min cooldown, but ONLY for retryable errors and only for stuck/orphan situations — many transient throws mark the job `failed` with no auto-recovery beyond the 5-min auto-heal cycle catching `retryable_error`.
**Why it matters**: Worse on small instances where SQLite contention is plausible; jobs that *would* succeed on retry are flagged as terminal failure until auto-heal claims them.
**Suggested fix**: Pass `maxAttempts=3` to `enqueueJob("pipeline.full", ..., 3)`. The job worker already has the requeue-with-backoff codepath (`lib/jobs.ts:173-183`).

### [P1] Boot hooks and auto-heal report errors to `pipeline_log` only — no surface to operators or alerts
**File**: `template_v0/lib/boot.ts:68-71, 110-113`; `template_v0/lib/auto-heal.ts:421-451, 500-509`
**Issue**: When `recoverGreyCloudOnce` or `orphanDropletSweepOnce` fails (e.g., one of the 60 domains has a stale CF key that 401s), the loop swallows the error into `logPipeline(d.domain, ..., "warning", ...)` and continues — fine, that's defensive. But if the WHOLE auto-heal tick crashes (e.g., DB lock), `setTimeout(() => { void autoHealTickOnce().catch((e) => logPipeline... })` writes a single warning line and that's it. There's no metric, no notification, no `appendAudit`. A long-broken auto-heal silently turns the system into "manual mode" without anyone knowing.
**Why it matters**: At 100+ domains, auto-heal is doing the real work — a silent stall = silent backlog of stuck pipelines.
**Suggested fix**: When `autoHealTickOnce` throws (the OUTER catch), call `notify(...)` with `dedupeKey="auto_heal_crashed"` so the operator gets paged; also `appendAudit("auto_heal_crashed", ..., e.message)`.

### [P1] Pipeline-launching API routes (`run-pipeline`, `run-from/[step]`, `run-bulk`, `run-bulk-sequential`) leave no audit trail
**File**: `template_v0/app/api/domains/[domain]/run-pipeline/route.ts`, `template_v0/app/api/domains/[domain]/run-from/[step]/route.ts`, `template_v0/app/api/domains/run-bulk/route.ts`, `template_v0/app/api/domains/run-bulk-sequential/route.ts`
**Issue**: These four routes are the most state-consequential in the system — they spend money (DO + Spaceship), provision infrastructure, and call CF. None of them call `appendAudit`. Compare to `app/api/servers/destroy-all/route.ts:23` which audits properly. After a "why did 12 droplets get created at 03:00?" incident, the only forensic trail is `pipeline_log` (which doesn't capture the actor IP) and `pipeline_runs` (no actor either).
**Why it matters**: Forensics + accountability. Multiple operators sharing a dashboard cannot attribute a bulk-run.
**Suggested fix**: Add `appendAudit("pipeline_run", domain, JSON.stringify({ start_from, server_id, force_new_server, custom_provider }), ip)` to the four routes (extract the IP the same way `auth/login` does).

### [P1] Login route does not audit failed/successful logins to `audit_log`
**File**: `template_v0/app/api/auth/login/route.ts`
**Issue**: `recordLoginAttempt(ok, ip)` writes to a separate `login_attempts` table (used by the throttle), but there's no `appendAudit("login_success" | "login_failure", "", ...)` row. The `audit_log` UI at `/audit` won't show anything about who logged in / when. Same for `/api/auth/logout/route.ts`.
**Why it matters**: Incident response can't tell whether a malicious actor exfiltrated DO tokens via the dashboard around the time of an outage.
**Suggested fix**: Append to audit_log on both success and failure, including the IP.

### [P1] CF Workers AI pool retry caps at 6 attempts even when 10+ rows are configured
**File**: `template_v0/lib/website-generator.ts:644` (`for (let attempt = 0; attempt < 6; attempt++)`)
**Issue**: Hardcoded 6. Operators are encouraged in `v9_state.md` to add many CF AI accounts to stack the 10k/day free tier. A bulk-run hitting the same hour-long window as the operator's other personal use will burn through 6 rows fast, then the user sees `AiPoolExhausted` on row 7 even though rows 8-15 might still have neurons.
**Why it matters**: Direct usability hit at scale + obscure error message.
**Suggested fix**: Loop until `getNextAiKey(tried)` itself throws `AiPoolExhausted` — the function already tracks active-row count and is the authoritative "are there any rows left to try" oracle. Drop the 6-cap.

## P2 — Should fix

### [P2] No prometheus / OTel / statsd hooks anywhere — visibility = SQLite logs
**File**: whole repo (search for `prom`, `metric`, `otel`, `statsd` returned zero)
**Issue**: At ≤100 domains, dashboard + `pipeline_log` polling is workable. At 1k it's painful (the dashboard's own `/api/logs` query gets slow), at 10k it's flying blind. There's no per-step latency histogram, no per-CF-key error counter, no DO API quota gauge.
**Why it matters**: Capacity planning and incident-debugging both stall when logs are the only signal.
**Suggested fix**: Adding `prom-client` and exposing `/api/metrics` would be ~100 LOC: `pipeline_step_duration_seconds{step}` histogram from the existing `step_tracker.started_at`/`finished_at`, `cf_api_errors_total{code}` from a counter incremented inside `cfRequest`, `do_droplet_creates_total` from `checkAndRecordCreation`. Same approach for SA + LLM providers.

### [P2] No graceful shutdown for the live-checker `runningPromise`
**File**: `template_v0/lib/live-checker.ts:357-400` (loop is `while (!stopRequested)`)
**Issue**: `live-checker.stop()` exists (`:412-417`) and works, but nothing calls it on shutdown — there's no SIGTERM handler. So on container exit, the supervisedLoop just gets killed mid-tick. Streaks reset (acceptable — they live in module memory) but a `migrating.add(serverId)` slot may be leaked into the next process *if* a different process inherits the SQLite migration state — this is rare since `migrating` is also in-memory, but still: `auto-migrate-pending` rows in pipeline_log can show up orphaned.
**Why it matters**: Defense in depth; current behavior is mostly fine.
**Suggested fix**: Wire `live-checker.stop()` and `jobs.stopPool()` into the SIGTERM handler from P0 above.

### [P2] `recoverOrphans()` in jobs runs only at process boot — not on a schedule
**File**: `template_v0/lib/jobs.ts:100-139, 233-242`
**Issue**: If a worker mysteriously goes silent (stuck SSH, infinite-loop in handler, GC pause), the job stays at `status='running'` forever — until process restart. There's no per-tick "if `locked_at < now - 30 min`, requeue" check. The auto-heal sweeper will detect the pipeline stall via `last_heartbeat_at` cooldown, but the underlying job row stays "running" so a *different* worker claiming a duplicate of that pipeline won't be blocked by the slot-lock-check pattern.
**Why it matters**: Slow leak of `running` jobs over weeks. Workers shrink over time.
**Suggested fix**: Add a 5-min ticker that calls a soft variant of `recoverOrphans` — only requeue rows where `now - locked_at > N minutes`. Mirror the auto-heal cadence.

### [P2] Errors from the LLM `cliMode` (codex/gemini CLI) provide no retry path
**File**: `template_v0/lib/website-generator.ts:284-290, 547-560`; `template_v0/lib/llm-cli.ts` (not read here but invoked)
**Issue**: A failing `runLlmCli` (codex CLI not installed, OAuth expired, network blip) throws — caught by step9 outer catch which marks the step `failed`. No retry against a different CLI/provider. Compare to `cloudflare_pool` which is the only branch with a "try the next account" loop.
**Why it matters**: Free-tier reliability is brittle.
**Suggested fix**: On CLI failure, fall back to API mode if a key is configured; or fall back to a different provider if `llm_provider_fallback` is set.

### [P2] `purgeZoneCache` is fire-and-forget with `.catch(() => {})` — no observability on stale CF cache
**File**: `template_v0/lib/pipeline.ts:1093, 1209` (both via `void purgeZoneCache(domain).catch(() => { /* logged inside */ })`)
**Issue**: The callsites swallow rejections. `cloudflare.ts:540-545` does log the failure inside, but there's no metric / counter / audit. Repeated purge failures across many domains are invisible until visitors complain.
**Why it matters**: Observability nit; correctness is fine (purge is best-effort by design).
**Suggested fix**: At minimum, increment a counter (when metrics land); intermediate fix is `appendAudit("cf_purge_failed", domain, msg)` so the audit page shows a recent burst.

### [P2] No process-level rate limit on outbound CF / DO / SA bursts at startup
**File**: `template_v0/lib/boot.ts:127-167`
**Issue**: `scheduleBootHooks` fires `recoverGreyCloudOnce` (potentially hundreds of CF list-records calls) 5 s after boot on a single goroutine. Auto-heal fires 60 s after boot. Live-checker (when enabled) fires immediately. None coordinate. On a 200-domain restart, CF sees a synchronized burst from one IP — risk of `1015` rate-limit or our own per-key semaphore stall. Concurrency module exists but is per-key, not global.
**Why it matters**: Primarily a scale-tolerance issue; small footprints don't notice.
**Suggested fix**: Add a global `withGlobalRateLimit("cf", 50/s, fn)` wrapper, OR jitter the boot hooks (instead of fixed 3/5/8/60 s, use random within 30-120 s).

### [P2] Audit log table grows unbounded — no rotation
**File**: `template_v0/lib/repos/audit.ts:51-59`
**Issue**: `appendAudit` is just an INSERT. Whether on a small instance or a 10k-domain instance, the table grows forever. The pipeline_log has the same issue (`lib/repos/logs.ts:3-11`). At scale, dashboard load slows + DB grows. There's no `DELETE WHERE created_at < NOW() - 90 days` / VACUUM.
**Why it matters**: Pipeline logs especially can hit millions of rows with `pipelineWorker`'s 1 s heartbeat ticker for a 10-min run × many concurrent runs.
**Suggested fix**: Daily cleanup tick. Keep last 90 days of audit, last 30 days of pipeline_log, last 14 days of pipeline_runs.

## P3 — Nits

### [P3] Pipeline error responses leak stack traces (4 KB) into `pipeline_log` rows
**File**: `template_v0/lib/pipeline.ts:638-640`
**Issue**: `(err.stack ?? "").slice(0, 4000)` is dumped into `pipeline_log.message`. Stack traces include node_modules paths that may reveal internal structure, and they bloat the table. Useful for debugging but should arguably be split off into a separate `pipeline_errors` table or truncated harder for the visible message and full-stack only when the operator clicks "view details".

### [P3] `error: (e as Error).message` style leaks raw upstream errors to API consumers
**File**: 14 places, mostly `app/api/sa/*/route.ts` and `app/api/settings/test-llm-key/route.ts`
**Issue**: These return the raw error message verbatim — usually safe for SA/LLM APIs (they don't return secrets), but a bad SA-API-side bug could in principle echo back the Authorization header or similar. The dashboard is auth-gated so the impact is small.
**Suggested fix**: At minimum strip any `Authorization:` / `X-API-Key:` / `X-Auth-Key:` substrings before returning, OR collapse to a generic "ServerAvatar refused: HTTP 502" and put the detail in pipeline_log only.

### [P3] `logPipeline` is unstructured (free-form `message` string)
**File**: `template_v0/lib/repos/logs.ts:3-11`
**Issue**: Step / status / domain ARE columns (good — grep-friendly), but the bulk of operationally-useful data is in the freeform `message` (`"zone=abcd... NS=foo,bar status=active"`). Can't easily aggregate "all errors in step 8" by error code, or correlate "all events for domain foo.com between 03:00 and 03:30 grouped by step". 
**Suggested fix**: Either (a) add a `message_json` column for structured payload + keep `message` for the human one-line, or (b) standardize the `message` format to `key=value key=value` so awk/grep is reliable. The codebase mostly does (b) already — formalizing it is cheap.

### [P3] Audit page query lacks an index on `(action, created_at)`
**File**: `template_v0/lib/repos/audit.ts:36` (`ORDER BY id DESC LIMIT ? OFFSET ?`)
**Issue**: At 10k+ rows the OFFSET-paginated query gets slow. Most filters are by `action`. Adding `CREATE INDEX IF NOT EXISTS audit_action_id ON audit_log(action, id DESC)` is a one-liner.
**Suggested fix**: Index migration in db.ts (or wherever schema migrations land).

### [P3] Live-checker's `streakUp/Down` maps grow without GC for deleted domains
**File**: `template_v0/lib/live-checker.ts:33-34`
**Issue**: When a domain is deleted from the DB, the streak entries linger in module memory until process restart. Memory leak per delete; small in absolute terms.
**Suggested fix**: Inside `tick()`, build the active-domain set from the rows fetched and prune `streakUp`/`streakDown` entries not in the set.

## Clean lenses

- **External API timeout coverage on DigitalOcean**: every fetch has explicit `AbortSignal.timeout` with sensible values (15-60 s).
- **External API timeout coverage on ServerAvatar**: same — `saRequest` defaults to 30 s; SSH ops have explicit per-cmd timeouts.
- **DO/SA primary→backup token failover**: implemented correctly with non-failover-status pass-through and `*-AllTokensFailed` typed errors. CF DNS pool also has its own multi-key rotation (`cf-key-pool.ts`).
- **CF zone create idempotency**: handles 1061/1097/1100 + "already exists" body string and falls through to GET-then-return.
- **SA app create idempotency**: step 7 catches "already exists" and reuses `findAppId` result.
- **Step-level resume**: per-domain slot lock + `step_tracker` per-step status + "force re-run" semantics for `start_from`. Resumption-from-failure is the strongest part of the codebase.
- **Step 8 origin-CA pending-zone path**: dedicated `OriginCaZoneNotActiveError` → `PipelineWaitDns` → revert status to `ns_set` → auto-heal resumes from step 5. Recent (commit ae3ed00) fix.
- **Boot orphan-droplet sweep**: detects but doesn't auto-destroy — correct conservative posture.
- **Login throttle**: works (separate table, `recordLoginAttempt`, `loginThrottleCheckAndReserve`).
- **HMR-safe globals**: every singleton (job pool, auto-heal timer, in-flight set, `__ssrBooted` boot guard) is keyed on globalThis to survive Turbopack re-eval. Notably correct.
- **Live-checker supervisor loop**: crash-loops are detected (`>3 restarts in <60s` → give up); inner exceptions don't kill the whole checker.
- **Notify dedupe**: 10 min sliding window per dedupeKey prevents 60-domain DO outage from paging the operator 60 times.
- **Pipeline cancel**: `cancel_requested` column + `checkCancel` at every step boundary works correctly.
- **Idempotency on `assignCfKeyToDomain`**: fast-path returns existing without incrementing; race-safe atomic counter.
