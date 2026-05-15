# Data integrity + concurrency audit — 2026-04-30

**Verdict**: 14 findings (1 P0, 5 P1, 6 P2, 2 P3). Strong fundamentals (WAL, FK pragma, BEGIN IMMEDIATE for hot pools, slot lock, per-step lock, HMR-safe globals); the gaps are around (a) crash-recovery for jobs that only run on boot, (b) several multi-row writes in cf-key-pool / pipeline / migration that should be inside a single transaction, (c) FK columns declared but not enforced (the prod schema is owned by Flask, so FK enforcement depends on what Flask actually wrote in `init_db`), and (d) no DB backup story at all.

## P0 — Production blockers

### [P0] No SQLite backup / snapshot anywhere — single point of catastrophic data loss
**File**: `lib/db.ts`, repo-wide search
**Issue**: There is no online-backup, flat-file copy, `VACUUM INTO`, or `db.backup()` call anywhere in `template_v0/` or its scripts. The DB at `data/ssr.db` is the source of truth for domains, servers, CF/SA/DO credentials (encrypted), CF key pool slot accounting, jobs, pipeline_runs, audit_log, master prompt history. The only "backup" referenced in the codebase is the `do_api_token_backup` *secondary credential*, not data backup.
**Why it matters**: If `data/ssr.db` is corrupted (mid-write power loss is mostly survivable thanks to WAL + journal_mode, but a disk failure, an `rm` typo, a bad migration, or a crashed VM is not), the operator loses every domain row, every CF key slot count, every encrypted secret, every audit trail. Without snapshots there is also no point-in-time recovery — a wrong `DELETE` from a script is unrecoverable. Fernet key file `.ssr_secret_fernet` is similarly single-copy: lose it and every encrypted setting becomes unreadable, which decrypts as `""` (per `decrypt()` line 191) and silently breaks the system rather than alerting.
**Suggested fix**: Add a periodic backup (cron / scheduled hook in `lib/boot.ts`) using `db.backup()` (node:sqlite supports the SQLite Online Backup API) to a rotated daily file in `data/backups/ssr-YYYYMMDD.db`. Keep N=7 days. Include `.ssr_secret_fernet` in the same backup directory. Document a restore runbook. Without this, "production-readiness" doesn't actually exist.

## P1 — Must fix before prod

### [P1] `assignCfKeyToDomain` increments cf_keys.domains_used WITHOUT updating the domain row in the same transaction
**File**: `lib/cf-key-pool.ts:127-167`
**Issue**: The function does `BEGIN IMMEDIATE`, runs `UPDATE cf_keys SET domains_used = domains_used + 1`, then runs `UPDATE domains SET cf_key_id = ?`, then `COMMIT`. That part is correct. BUT the read on line 95 (`SELECT cf_key_id FROM domains WHERE domain = ?`) and the candidate pick on line 110 (`getNextAvailableCfKey()`) happen OUTSIDE the BEGIN. If two parallel pipeline workers call `assignCfKeyToDomain(d)` for two different domains at the same instant, both can read the same LRU candidate, then the loser's `UPDATE … WHERE domains_used < max_domains` rejects (line 140 retry path) — that retry calls `assignCfKeyToDomain(domain)` recursively but this re-enters with `keyId=undefined`, picking another row. So the slot accounting is safe. HOWEVER: the same domain entered concurrently (e.g. user double-click that races past the slot lock because the slot lock is in a DIFFERENT process / Flask side calls the same Node code) would see `existing.cf_key_id == null` on both reads, both candidates increment `domains_used`, the second overwrites the first's `cf_key_id` write, and the FIRST key is permanently leaked at `domains_used+1` with no domain pointing at it. There is no `ON CONFLICT (domain) DO NOTHING` guard on the second `UPDATE`.
**Why it matters**: CF key pool capacity drift. Over weeks of operation the dashboard will report keys at `domains_used=18/20` but only 15 actual domains pointing at them. Eventually the pool reports "exhausted" while every key has real headroom — operator has to manually run a SQL recompute. Also leaks mid-flight if step 2 fails after the increment but before the `UPDATE domains`.
**Suggested fix**: Move the existing-row check into the BEGIN IMMEDIATE block, and guard the domain UPDATE with `WHERE cf_key_id IS NULL` so a concurrent winner makes the loser's UPDATE a no-op. On no-op, ROLLBACK and don't double-increment.

### [P1] Job pool only recovers orphans on boot — no in-flight stuck-job sweeper
**File**: `lib/jobs.ts:233-242` (startPool calls recoverOrphans once)
**Issue**: `recoverOrphans()` is invoked exactly once, inside `startPool()`. If a worker crashes mid-job WITHOUT taking down the whole process (uncaught exception in a child fetch swallowed somewhere, an unhandled rejection, an `await` that never resolves because the upstream API hung past `AbortSignal.timeout`), the row sits at `status='running'` forever. The auto-heal sweeper in `lib/auto-heal.ts` only watches DOMAIN status, not job status — it never queries `jobs WHERE status='running' AND locked_at < now-1h`. There's also no heartbeat on the JOB row itself (heartbeat updates the DOMAIN row only).
**Why it matters**: A LLM call wedged behind a 5-minute timeout that fires AFTER the job worker's `await` chain has been unwound by an upstream rejection (rare, but possible in the cf-ai-pool fan-out path) leaves `jobs.status='running'`. The next worker won't pick it up (claimOne filters `status='queued'`), the auto-heal won't touch it, and the operator has no UI to clear it short of `UPDATE jobs SET status='failed' WHERE …`.
**Suggested fix**: Add a periodic stuck-job sweeper (every 5 min, like auto-heal) that scans `WHERE status='running' AND locked_at < now - SSR_JOB_STUCK_AFTER_S (default 1800)` and routes them through the same path `recoverOrphans` uses. Bonus: have the worker pulse `jobs.locked_at = now()` every 30s during a long handler so the sweeper can trust the heartbeat instead of relying on `claimOne`'s timestamp.

### [P1] `attempt_count`-based orphan failover is broken for `max_attempts=1` (the default)
**File**: `lib/jobs.ts:100-138` (recoverOrphans), `lib/jobs.ts:141-158` (claimOne)
**Issue**: `claimOne` increments `attempt_count` to 1 IMMEDIATELY on claim (line 152). If the process is killed mid-handler, on next boot `recoverOrphans` checks `WHERE status = 'running' AND attempt_count >= max_attempts` — for the default-enqueued `pipeline.full` (`enqueueJob(kind, payload, maxAttempts=1)` callers), `attempt_count(1) >= max_attempts(1)` is TRUE → the job is marked failed without retry. The intended behavior (presumably) is "give it one MORE try after a crash," but the increment-on-claim semantics turn the "max_attempts" knob into "max_attempts - 1" after a crash. The "skipped: domain already at success" guard on lines 117-130 partially papers over this for pipeline jobs but doesn't help cf-bulk, cert-backfill, server.create, server.destroy_all, server.migrate_now, domain.teardown, domain.bulk_teardown, or domain.bulk_migrate.
**Why it matters**: A worker dying during a server-create / destroy-all / cf-bulk job leaves the job permanently failed even though it never ACTUALLY consumed an attempt — the increment-on-claim happened in the same transaction as the lock. Operator has to re-enqueue manually.
**Suggested fix**: Either (a) increment `attempt_count` on FAILURE not on CLAIM, or (b) recovery should requeue rows where `attempt_count <= max_attempts` (use `<` instead of `>=`), or (c) document `max_attempts` semantics as "claims" not "attempts" and make handlers idempotent. Option (a) is the cleanest.

### [P1] FK declarations exist in test schema but are not relied upon — `pragma foreign_keys=ON` may not enforce because the prod schema is Flask-owned
**File**: `lib/db.ts:36`, `tests/_setup.ts:46-47, 155`, `lib/repos/domains.ts:63-65`
**Issue**: `lib/db.ts` enables `PRAGMA foreign_keys = ON`. The TEST schema declares two FKs (`domains.cf_key_id REFERENCES cf_keys(id)`, `domains.server_id REFERENCES servers(id)`, `pipeline_step_runs.run_id REFERENCES pipeline_runs(id)`). However, the PROD schema lives in the Flask side (per `lib/db.ts:6-8`); this Node code never CREATEs those tables. If Flask declared them WITHOUT FK clauses (or with `ON DELETE` actions different from what the Node code expects), the runtime behavior diverges from tests. Worse: `deleteCfKey` (lib/repos/cf-keys.ts:62-67) does its own application-level reference check (`SELECT COUNT(*) FROM domains WHERE cf_key_id = ?`) — so it correctly refuses delete-with-references — but `deleteServerRow` (lib/repos/servers.ts:50-52) does NOT, and `destroy-all.ts` only checks the count BEFORE deleting (line 38, no transaction wrapping). If a domain is created with `server_id=N` BETWEEN the count-check and the DELETE, the orphaned domain row survives with a dangling `server_id`.
**Why it matters**: Silent referential-integrity drift. Domains pointing at deleted servers will fail step 7 with a confusing "server not found" later. The "soft-delete cascade" claim in the v8 memory file isn't actually implemented in this codebase — there is no `deleted_at` column anywhere (`grep deleted_at` returns 0 hits). Soft-delete is at most a Flask concept.
**Suggested fix**: (a) Add an explicit `ON DELETE` policy to the prod schema (operator should verify Flask's `init_db` declares the FK clauses), (b) wrap `destroyAllHandler`'s per-server count-check + DELETE in a single transaction with `WHERE NOT EXISTS (SELECT 1 FROM domains WHERE server_id = ?)`, (c) explicitly state in CLAUDEMD whether soft-delete is real.

### [P1] `deleteCfKey`'s reference check + DELETE are not transactional
**File**: `lib/repos/cf-keys.ts:62-67`
**Issue**:
```ts
const ref = one<{ n: number }>("SELECT COUNT(*) AS n FROM domains WHERE cf_key_id = ?", id)
if (ref && ref.n > 0) return { ok: false, reason: ... }
run("DELETE FROM cf_keys WHERE id = ?", id)
```
A pipeline.full enqueued between the SELECT and the DELETE will run `assignCfKeyToDomain(d)` and INSERT a row pointing at this `cf_key_id` after the count-check returned 0. The DELETE then succeeds; the new domain row holds a dangling FK (pragma_foreign_keys would catch this only if FK declarations exist on the prod table, see [P1] above).
**Why it matters**: Same as the FK-drift issue — a domain gets created with a `cf_key_id` pointing at a deleted key. The domain's CF API calls then fail later in step 3 with auth errors rather than at delete-time with a clean "still in use" message.
**Suggested fix**: Wrap in `BEGIN IMMEDIATE` and re-check inside the transaction OR rely on a real FK constraint with `ON DELETE RESTRICT`.

## P2 — Should fix

### [P2] `pipeline.ts:step6 → updateStep + setStepArtifact + updateServer + updateDomain` is 3-4 separate writes with no transaction
**File**: `lib/pipeline.ts:833-908` (step6GetOrProvisionServer)
**Issue**: After successfully provisioning a server, step 6 does:
```
updateServer(serverId, { sa_server_id: saServerId, status: "ready" })   // write 1
updateStep(domain, 6, "completed", ...)                                  // write 2
setStepArtifact(domain, 6, {...})                                        // write 3 (BEGIN IMMEDIATE inside)
return findServer(serverId)                                              // SELECT
```
If the process is killed between writes 1 and 2, the server is marked ready but step_tracker thinks step 6 is still "running" — the next pipeline pass on this domain (via auto-heal) will re-call `step6GetOrProvisionServer`, which does idempotency check at the top — but ONLY when `findServer(explicitServerId)` returns a row. The smart-resume on line 522-530 reads `getDomain(domain)?.server_id` — which `step7CreateAppAndDns` later writes via `updateDomain(domain, { server_id: server.id })` (line 955), but `step6GetOrProvisionServer` itself does NOT write `domains.server_id` (it returns a ServerRow but doesn't link it to the domain). So a kill between write 1 and write 7's domain write means `getDomain(domain)?.server_id` is null → smart resume on line 533-541 fails with "Cannot resume from step N: no server associated."
**Why it matters**: A crash mid-step-6 leaves the pipeline unrecoverable via auto-heal (the only other resume path requires `domains.server_id` to be set). The artifact carries `server_id` but the resume path doesn't read step artifacts to backfill the domain row. Operator has to manually figure out which server got created.
**Suggested fix**: At the end of step 6, call `updateDomain(domain, { server_id: serverId })` BEFORE returning. Wrap the post-provision writes (server status update + step_tracker + artifact + domain row) in a single transaction.

### [P2] `migrateDomain` updates domain row at the end with no transaction guarding the multi-step external-side-effect chain
**File**: `lib/migration.ts:325-518`
**Issue**: A successful migration writes `updateDomain(domain, { server_id, current_proxy_ip, status: 'hosted' })` exactly once at the bottom (line 478-482). If the process is killed AFTER the SA app is created on the new server + SSL is installed + content is uploaded + CF records are PATCHed but BEFORE the domain row update commits, the DB row still points at the OLD server. A subsequent live-checker tick will (a) probe via CF, (b) get back the now-correct content from the new server, and (c) keep going — but `domains.server_id` is wrong, breaking subsequent migrations / teardowns / auto-heal which all rely on `server_id` to find the right SA server. The cumulative side-effect chain (CF PATCH, SA cleanup of old, archive write) is not idempotent if rerun against half-migrated state.
**Why it matters**: Operator runs a bulk migration of 50 domains; the process crashes after 30 are visually migrated but rows still say old server. Recovery requires manual SQL.
**Suggested fix**: Write `updateDomain(domain, { server_id: newId })` AFTER step 1 (SA app created) instead of waiting until the end — that's the earliest moment the new server's app exists. Subsequent failures keep the domain pointing at the new server but mark it `retryable_error` so auto-heal can finish the SSL/content steps.

### [P2] `cf-ai-pool.recordAiKeyCall` and `recordAiKeyError` fire serially after the LLM call returns — not crash-safe
**File**: `lib/cf-ai-pool.ts:108-138`, `lib/website-generator.ts:646-679`
**Issue**: `getNextAiKey` correctly uses BEGIN IMMEDIATE to atomically pick + stamp `last_call_at`. However, `recordAiKeyCall` (which bumps `calls_today/calls_total`) runs ONLY after `await callCloudflareWorkersAi(...)` resolves. If the process crashes mid-call, the `last_call_at` bump from `getNextAiKey` makes that row look "recently used" (so the next caller skips it via LRU) but `calls_today` was never incremented → daily-quota accounting under-counts. Inverse problem on `recordAiKeyError`: the error stamp is also post-await, so a hard kill mid-fetch leaves NO trace on the row.
**Why it matters**: Daily neuron-budget reporting in the dashboard is wrong after every crash. Not catastrophic but defeats the point of a "free-tier stacker."
**Suggested fix**: Either pre-increment `calls_today` inside `getNextAiKey`'s same transaction (pessimistic — over-counts on success path), or move accounting to a write-ahead log table. Pessimistic over-count is safer (dashboard slightly conservative > silently exceeds quota).

### [P2] `step9GenerateContent` writes `domains.site_html` + `updateStep` + `setStepArtifact` separately (3 writes, no transaction)
**File**: `lib/pipeline.ts:1102-1168`
**Issue**: Same pattern as step 6 — 3 sequential writes. A crash between `updateDomain({ site_html })` and `setStepArtifact` means the cached HTML is on the row but `step_tracker` thinks step 9 is still running, AND the multi-file siblings (per the comment on line 575-580) aren't reconstructable from the artifact. The resume code on line 577 specifically depends on the artifact being present.
**Why it matters**: Resume path silently regenerates instead of using the (already-paid-for) cached single-file output. Cost waste, not data loss.
**Suggested fix**: Bundle the writes in a transaction.

### [P2] `releaseCfKeySlot` clamps domains_used at 0 but isn't transactional with the domain update
**File**: `lib/repos/domains.ts:67-79`
**Issue**:
```ts
run("UPDATE cf_keys SET domains_used = MAX(0, domains_used - 1) WHERE id = ?", row.cf_key_id)
run("UPDATE domains SET cf_key_id = NULL WHERE domain = ?", domain)
```
A crash between writes leaves the slot freed but the domain still pointing at the key — next teardown of the same domain (from a stuck-job retry) would decrement again. The MAX(0, ...) clamp prevents it from going negative, but the actual count drifts under repeated partial executions.
**Why it matters**: Slot accounting drift again. Bounded by MAX(0, ...) so it can only under-count, but still wrong.
**Suggested fix**: Wrap in BEGIN IMMEDIATE.

### [P2] `recordAiKeyError` doesn't share a transaction with `getNextAiKey`'s last_call_at stamp; the row's `last_error` is stamped after the LRU pick clock has already moved
**File**: `lib/cf-ai-pool.ts:133-138`
**Issue**: Minor, but `recordAiKeyError` is a single UPDATE with no transaction wrapper. Concurrent successful call on the same row could overwrite `last_error = NULL` (via `recordAiKeyCall` which clears it on line 123) AFTER the error stamp landed, hiding the failure from the operator UI. Race window is tiny but exists.
**Suggested fix**: `recordAiKeyError` should use `WHERE id = ? AND last_call_at = ?` to only stamp if the row hasn't been re-claimed since the failing call started. Or: just accept the lossy semantics and document it.

## P3 — Nits

### [P3] `instrumentation.ts` swallows ALL `registerHandler` errors silently
**File**: `instrumentation.ts:12-29`
**Issue**: Every `try { registerHandler(...) } catch {}` discards the error. If a handler import fails (typo, broken module, missing dependency), the job kind silently has no handler and `runOne` (jobs.ts:188) marks all jobs of that kind as failed forever with `"No handler registered"`. There's no boot-time log of "I registered 11 handlers" vs "I tried to but 3 failed."
**Suggested fix**: Log handler registration failures via `logPipeline("(boot)", "register_handler", "warning", ...)`. They should be loud, not silent.

### [P3] `live-checker.ts` writes status flips without a transaction, can race with auto-heal
**File**: `lib/live-checker.ts:117-133`
**Issue**: Live-checker flips `domains.status='live'` / `'hosted'` based on streak counts that are PER-PROCESS (Map in module scope, line 33-34). If both Flask and Node live-checkers run (the env-var guard on `boot.ts:158` + the warning in `live-checker.ts:11-13` say not to, but if an operator forgets), each maintains its own streak and the domain status flips chaotically. Even single-process: auto-heal's `autoFixBrokenSsl` re-fires a pipeline that walks status `live → hosted`, racing with the live-checker tick that may have just flipped it the other way. Each individual write is fine, but the higher-level invariant "status reflects reality" gets noisy.
**Suggested fix**: Document the constraint clearly. Consider moving streak counters into a DB table so both processes converge, OR add a leader-election keystone (the "first to write a row to a `live_checker_lock` table this minute owns this tick").

## Clean lenses
- HMR-safe state: every module-level singleton uses `globalThis.__ssr*` — `__ssrDb`, `__ssrJobPool`, `__ssrJobHandlers`, `__ssrInflightDomains`, `__ssrLoginAttempts`, `__ssrSemaphores`, `__ssrAutoHealTimer`, `__ssrAutoHealStartScheduled`, `__ssrBooted`, `__ssrDropletCreations`. Verified comprehensive.
- DB connection: single shared `DatabaseSync` instance cached on globalThis; `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=10000` all set in `lib/db.ts:35-37`. Test setup mirrors prod.
- Login throttle TOCTOU: previously fixed via `loginThrottleCheckAndReserve` (single-pass check + reserve). The login route uses it correctly (`app/api/auth/login/route.ts:12`). No regression.
- Per-domain slot lock: `tryAcquireSlot` / `releaseSlot` correctly used in `runFullPipeline`, `runBulkPipeline`, `runSequentialBulkPipeline`. Released in `pipelineWorker`'s `finally` (line 437) so throws don't leak slots. Teardown handler also acquires it (`handlers/teardown.ts:55-64`).
- Per-step lock release on error paths: `pipelineWorkerImpl` is wrapped in try/catch (line 446-643); slot release is in the OUTER `pipelineWorker`'s finally (line 415). Verified all step functions either return false (caught by wrapper) or throw (caught by outer). No leaked slots on any code path I traced.
- Semaphore release: `withSemaphore` (lib/concurrency.ts:64-73) uses try/finally — leak-free.
- Login session save: iron-session's `session.save()` is awaited in the route. No leak.
- Step-tracker `setStepArtifact`: explicitly wraps SELECT-merge-UPDATE in `BEGIN IMMEDIATE` (lib/repos/steps.ts:236-260). Correct shallow-merge race protection.
- Pool exhaustion behavior: CF AI pool throws `AiPoolExhausted`, CF key pool throws `CFKeyPoolExhausted`, LLM concurrency uses async semaphore with FIFO queue (no fail-fast, just waits). Documented and tested.
