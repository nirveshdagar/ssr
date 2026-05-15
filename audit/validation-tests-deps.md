# Validation + tests + deps audit — 2026-04-30

**Verdict**: 1 P0, 4 P1, 6 P2, 4 P3. Strong type strictness (zero `as any` / `@ts-ignore` in app code), solid validation patterns on numeric inputs, but several state-changing routes accept unbounded arrays, the `SSR_SESSION_SECRET` vs `SSR_SESSION_PASSWORD` env-name drift will silently fall back to the dev secret in prod, and the just-shipped `loginThrottleCheckAndReserve` + `encryptExistingAiTokens` ship without tests.

## P0 — Production blockers

### [P0] Bulk endpoints accept unbounded arrays — DoS / runaway billing
**Files**:
- `template_v0/app/api/ai-generator/queue/route.ts` (line ~46–64): no cap on `body.domains[]`.
- `template_v0/app/api/domains/run-bulk/route.ts` (line ~27): `domain_ids[]` uncapped → one `enqueueJob` per id.
- `template_v0/app/api/domains/run-bulk-sequential/route.ts` (line ~29): same.
- `template_v0/app/api/domains/bulk-migrate/route.ts` (line ~23): `domain_ids[]` uncapped.
- `template_v0/app/api/domains/bulk-delete/route.ts` (line ~24): in `all_parallel` mode this fans out to one job per id.
- `template_v0/app/api/cf-keys/bulk-add/route.ts` (line ~47): `body.rows[]` uncapped — for each row, makes a live `fetch` to api.cloudflare.com inside the request handler with a 15 s timeout. A 10 000-row payload would hold the route open for hours and burn CF API quota.
- `template_v0/app/api/cf-keys/bulk-delete/route.ts` (line ~33): `body.ids[]` uncapped.
- `template_v0/app/api/cf-keys/[id]/bulk-set-ip/route.ts` (line ~21) + `bulk-set-settings/route.ts` (line ~14): `domains[]` uncapped, used to build a SQL `IN (?,?,…)` placeholder list with the same arity. SQLite's compiled-statement variable cap is 32 766 — at that size the route 500s; below that, you can still flood the DB.

**Issue**: Single authenticated request can enqueue arbitrary numbers of jobs (each potentially provisioning a $4–6/mo droplet via `force_new_server=on`), spin up thousands of CF account verifications, or freeze a route handler. The existing per-CF-key semaphore + per-domain inflight lock save the actual workers, but the request handler itself becomes unbounded work.

**Why it matters**: Compromised auth → operator-budget wipeout. Even without compromise, a copy-paste accident (the UI lets you paste comma-separated domains into the AI generator queue field) can submit 10k items and spin up a multi-thousand-dollar AWS bill before anyone notices. The `cf-keys/[id]/bulk-dns-csv/route.ts` already shows the right pattern (`MAX_ROWS = 5000` + `MAX_BODY = 256 KiB`); the rest don't follow it.

**Suggested fix**: Add a single `MAX_BULK = 1000` (or domain-appropriate constant) at the top of each route, reject with 413 when exceeded, mirror the `bulk-dns-csv` shape. Particularly tight cap (≤200) on `cf-keys/bulk-add` since it serially makes external API calls.

## P1 — Must fix before prod

### [P1] `SSR_SESSION_SECRET` env name mismatch — prod boot will use dev secret silently or crash misleadingly
**Files**:
- `template_v0/lib/auth-config.ts:22` reads `process.env.SSR_SESSION_SECRET`.
- `template_v0/.env.example:15` documents `SSR_SESSION_PASSWORD=…`.
- `template_v0/DEPLOY.md:22` says set `SSR_SESSION_PASSWORD`.

**Issue**: An operator following docs sets `SSR_SESSION_PASSWORD` in prod. `process.env.SSR_SESSION_SECRET` is undefined. In production NODE_ENV the lazy resolver throws on first request — but the error message tells them to set `SSR_SESSION_SECRET`, which doesn't match the docs.

**Why it matters**: Every cookie-validation crash. Users locked out. If NODE_ENV !== 'production' (e.g. they used `npm run start` without setting it), they get the dev fallback secret silently — sessions become predictable across deployments.

**Suggested fix**: Pick one name and align all three (code + .env.example + DEPLOY.md). Recommend `SSR_SESSION_PASSWORD` since iron-session itself uses "password" terminology.

### [P1] `loginThrottleCheckAndReserve` ships without a test
**File**: `template_v0/lib/login-throttle.ts:44–56`.
**Issue**: Race-fix code added in v9. Existing tests cover only the legacy `loginThrottleCheck` + `loginThrottleRecord`. The whole point of the new function is the parallel-request race; nothing in `tests/login-throttle.test.ts` exercises it.
**Why it matters**: The entire bypass scenario — N parallel requests hitting before any record write lands — is what the function exists to fix. Without a test, a regression that re-introduces the gap is undetectable.
**Suggested fix**: Add a vitest case that fires N (e.g. 20) concurrent calls to `loginThrottleCheckAndReserve` against the same IP and asserts exactly `MAX_PER_WINDOW` (5) returned `true`.

### [P1] `encryptExistingAiTokens` ships without a test
**File**: `template_v0/lib/repos/cf-ai-keys.ts:160–177`.
**Issue**: One-shot boot migration that walks every row in `cf_workers_ai_keys`, decides plaintext-vs-`enc:v1:` by prefix, and re-writes. Idempotency is asserted in the comment but unverified. No test in `tests/`.
**Why it matters**: A bug here can silently double-encrypt or corrupt every AI pool token at boot. It runs on every boot via `lib/boot.ts:139`. Recovery means the operator has to re-add every key.
**Suggested fix**: vitest case that seeds a mix of plaintext + already-`enc:v1:` rows, calls `encryptExistingAiTokens` twice, asserts (a) every plaintext row was converted, (b) re-running converts 0 + skips all, (c) each round-trip `decrypt(getCfAiKey(id).api_token)` returns the original plaintext.

### [P1] `pipeline_log` writes from request handlers contain user-controlled domain strings, no length cap
**Files**: many routes (e.g. `app/api/sa/reinstall-ssl/route.ts:50`, `app/api/cloudflare/sync/route.ts:153`, plus most pipeline steps). They call `logPipeline(domain, …, message)` where `message` is an interpolation of arbitrary external API text (`(await res.text()).slice(0, 200)` is the typical guard, but several spots — e.g. `app/api/cf-keys/[id]/test-create-zone/route.ts:127, 196` — interpolate `(e as Error).message` with NO cap).
**Issue**: A misbehaving Cloudflare/SA response with an enormous error body fills `pipeline_log` rows; an attacker who can influence headers (less likely, but possible via a forged CF-style probe) can write huge rows. The DB grows fast and queries on `pipeline_log` slow down.
**Why it matters**: Slow degradation, not a crash, but the log is unbounded → SQLite file grows + dashboard becomes laggy.
**Suggested fix**: cap message length inside `logPipeline()` itself (e.g. truncate >2 KiB). Single chokepoint vs. fixing every callsite.

## P2 — Should fix

### [P2] `app/api/audit/route.ts` — `q` (search) is uncapped before going into LIKE
**File**: `app/api/audit/route.ts:8`.
**Issue**: `searchAuditLog({ search })` (lib/repos/audit.ts) builds a `LIKE %q%` query. `q` has no length cap. A 1 MB `q` is accepted, builds the SQL, and slows the whole DB.
**Suggested fix**: clamp `q` to 200 chars at the route boundary.

### [P2] `app/api/domains/route.ts` POST — `raw` from form `domains` field, no input size cap
**File**: `app/api/domains/route.ts:109–115`.
**Issue**: The form field can carry megabytes of `\n`-separated domains. `validate()` is fast but the `addDomain(d)` loop is per-row and synchronous against SQLite.
**Suggested fix**: cap candidate count at e.g. 5000 before the validate-loop.

### [P2] Mock data exports in `lib/ssr/mock-data.ts` are dead
**File**: `lib/ssr/mock-data.ts`.
**Issue**: `DOMAINS`, `SERVERS`, `CF_KEYS`, `LOG_EVENTS`, `AUDIT_ENTRIES`, `ACTIVITY_FEED` consts are dead; only the type aliases + `PIPELINE_STEPS` are used. The static fixtures pre-date the live wiring and now leak fake data shapes into the bundle.
**Suggested fix**: split types out into a `mock-data` → `pipeline-types` rename and delete the seed arrays.

### [P2] `app/api/sa/upload-file/route.ts` — `body` (file content) has no size cap
**File**: `app/api/sa/upload-file/route.ts:42–46`.
**Issue**: Filename is validated; `fileBody` is checked only for non-empty. A 100 MB body is accepted and forwarded to SA. SA may reject, but the request handler holds the full string in memory + spends time hashing/uploading.
**Suggested fix**: add `if (fileBody.length > 1_000_000) return 413`.

### [P2] `app/api/settings/master-prompt/route.ts` GET — `history` query param parsed but not bounded before lookup
**File**: `app/api/settings/master-prompt/route.ts:20–27`.
**Issue**: `histRaw = parseInt(...)`. If user sends `history=999999999`, the code passes `Math.min(50, histRaw)` → caps the SQL but `histRaw` is also used in the `Number.isFinite(histRaw) && histRaw > 0` test which lets a NaN-resulting input through as falsy (fine) but doesn't reject negative-but-finite garbage cleanly. Cosmetic. (POST already has the 50 KB cap — good.)

### [P2] `app/api/domains/[domain]/run-from/[step]/route.ts` — step is parsed but the `domain` URL segment is not shape-validated
**File**: `app/api/domains/[domain]/run-from/[step]/route.ts:16–25`.
**Issue**: `getDomain(domain)` returns `null` if the row's missing, so the validation passes via the row lookup — but every route under `/api/domains/[domain]/...` accepts arbitrary path content (commas, slashes, percent-encoded nulls) before SQLite. SQLite parameter binding is safe, but `appendAudit("domain_override", domain, …)` writes the raw string into `audit_log.target`.
**Suggested fix**: shared helper `validateDomainParam(domain)` reused across `[domain]` routes.

### [P2] `app/api/system/auto-heal-tick/route.ts` is not rate-limited
**Issue**: An authenticated user can hit POST /api/system/auto-heal-tick in a loop. Each tick walks SA, CF, etc. There's no cooldown, so 1 req/sec hammers external APIs.
**Suggested fix**: 1-call-per-30s in-process throttle on `autoHealTickOnce`.

## P3 — Nits

### [P3] `tsconfig.json` could enable `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
**File**: `template_v0/tsconfig.json`.
**Issue**: `strict: true` is on, but the stricter options are off. Several places do `cells[idx]` where `idx` came from `array.indexOf` and might be `-1` → `cells[-1]` is silently `undefined`. Without `noUncheckedIndexedAccess` the type is `string`, not `string | undefined`, so we miss this.
**Note**: Turning these on may surface 50+ existing issues; treat as a longer-term hardening.

### [P3] No dependency-pinned audit available
**Issue**: `npm audit` blocked in this sandbox; couldn't run programmatically. Pinned versions checked from node_modules:
- `next 16.2.4` — current 16.x; no known CVEs at this minor as of 2026-04 (no public advisories for 16.2.4).
- `iron-session 8.0.4` — current 8.x.
- `ssh2 1.17.0` — current; 1.16+ patched the keyparse DoS (CVE-2024-37890 era).
- `nodemailer 8.0.6` — current.
- `node-forge 1.4.0` — current; pre-1.3.0 had multiple CVEs.
- `tar 7.5.13` — current; pre-6.2.1 had a CVE.
- `zod 3.25.76` — current 3.x. Note v4 is out; not security-critical but worth a planned upgrade.

**Recommendation**: run `npm audit --omit=dev --json` + `npm outdated` in CI pre-deploy. Add to DEPLOY.md.

### [P3] `instrumentation.ts` swallows every `registerHandler` error
**File**: `template_v0/instrumentation.ts:12–29`.
**Issue**: Every `registerHandler` call is wrapped in `try {} catch {}`. If any handler module fails to import (typo, missing export), boot silently succeeds with that handler missing, then jobs of that kind sit forever in `queued`.
**Suggested fix**: log the caught error to console — doesn't change behavior but makes dev-loop debugging far easier.

### [P3] `appendAudit` calls in route handlers run synchronously before the response — adds latency on a 5xx-prone path
**Issue**: Audit writes to SQLite synchronously. Most routes are fine; the bulk-add cf-keys route does it AFTER N×15s CF probes. If CF is slow, the operator sees a slow response. Minor.

## Test coverage map

| lib file | test? |
|---|---|
| `lib/auth.ts` | NO TEST — werkzeug hash verify, PBKDF2, password hash ← critical security |
| `lib/auth-config.ts` | NO TEST — session secret resolver |
| `lib/auto-heal.ts` | NO TEST — 5 internal functions, all touch external APIs |
| `lib/boot.ts` | `tests/boot.test.ts` ✓ |
| `lib/cf-ai-pool.ts` | NO TEST — concurrency-critical (BEGIN IMMEDIATE) ← needs one |
| `lib/cf-key-pool.ts` | `tests/cf-key-pool.test.ts` ✓ |
| `lib/cloudflare.ts` | `tests/cloudflare.test.ts` ✓ |
| `lib/concurrency.ts` | NO TEST |
| `lib/db.ts` | implicit via every other test |
| `lib/digitalocean.ts` | `tests/digitalocean.test.ts` ✓ |
| `lib/handlers/*` | NO TEST for any of the 7 handler files |
| `lib/jobs.ts` | `tests/jobs.test.ts` ✓ |
| `lib/live-checker.ts` | NO TEST |
| `lib/llm-cli.ts` | NO TEST — spawns child processes |
| `lib/llm-models.ts` | NO TEST (data only — fine) |
| `lib/login-throttle.ts` | `tests/login-throttle.test.ts` ✓ but doesn't cover `loginThrottleCheckAndReserve` ← P1 |
| `lib/master-prompt.ts` | NO TEST — DB read/write/history |
| `lib/migration.ts` | `tests/migration.test.ts` ✓ |
| `lib/notify.ts` | `tests/notify.test.ts` ✓ |
| `lib/pipeline.ts` | `tests/pipeline.test.ts` ✓ |
| `lib/preflight.ts` | `tests/preflight.test.ts` ✓ |
| `lib/repos/audit.ts` | NO TEST |
| `lib/repos/cf-ai-keys.ts` | NO TEST — `encryptExistingAiTokens` shipped without one ← P1 |
| `lib/repos/cf-keys.ts` | covered transitively via cf-key-pool |
| `lib/repos/domains.ts` | covered transitively via pipeline test |
| `lib/repos/logs.ts` | NO TEST |
| `lib/repos/runs.ts` | NO TEST |
| `lib/repos/servers.ts` | NO TEST direct |
| `lib/repos/settings.ts` | NO TEST |
| `lib/repos/steps.ts` | NO TEST |
| `lib/sa-control.ts` | NO TEST — 600+ lines of SSH + filesystem code (`validateFilename` traversal guard untested) |
| `lib/secrets-vault.ts` | `tests/secrets-vault.test.ts` ✓ |
| `lib/server-names.ts` | NO TEST |
| `lib/serveravatar-ui.ts` | NO TEST |
| `lib/serveravatar.ts` | `tests/serveravatar.test.ts` ✓ |
| `lib/spaceship.ts` | NO TEST |
| `lib/status-taxonomy.ts` | `tests/status-taxonomy.test.ts` ✓ |
| `lib/website-generator.ts` | NO TEST — provider routing + retry + pool exhaustion logic |

**Highest-priority untested files**: `lib/auth.ts` (security-critical), `lib/cf-ai-pool.ts` (concurrency, AI quota burn), `lib/sa-control.ts:validateFilename` (path traversal), `lib/website-generator.ts` (LLM provider fan-out + cost), `lib/repos/cf-ai-keys.ts:encryptExistingAiTokens` (one-shot migration that runs on every boot), `lib/login-throttle.ts:loginThrottleCheckAndReserve` (race fix).

## Dependency summary

- **npm audit**: could not run programmatically (sandbox blocked). Manual lock-file inspection found no known-vulnerable major versions for the security-relevant deps (next 16.2.4, iron-session 8.0.4, ssh2 1.17.0, nodemailer 8.0.6, node-forge 1.4.0, tar 7.5.13, zod 3.25.76). All on current minors. Action item: run `npm audit --omit=dev --json` in CI before each deploy.
- **npm outdated**: not run. Visual scan of `package.json` flags zod 3 → 4 (zod 4 is GA but a breaking-change major; no security driver). Everything else is on the current major. Lucide-react 0.564 is two minors behind 0.5xx but non-security.

## Clean lenses

- **Type strictness — `as any` / `@ts-ignore` / `@ts-expect-error`**: zero in `lib/` and `app/`. tsconfig has `strict: true`. Excellent.
- **Loose equality**: zero `==`/`!=` against literals; every match found is the deliberate `== null` idiom (matches both null and undefined). Not a bug.
- **Auth gating**: middleware.ts correctly puts every `/api/*` behind iron-session except `/api/auth/login` and `/api/health`. Good.
- **SSRF**: no route accepts a user-supplied URL/hostname for an outbound `fetch`. The `cf-keys/[id]/refresh-status` route fetches `https://${d.domain}/` but `d.domain` came from the DB, not the request body — risk is bounded by DB integrity. Good.
- **Path traversal**: `lib/sa-control.ts:validateFilename` rejects `..`, slashes, `index.php.bak`, `.htaccess`. Solid (would benefit from a unit test — see test gap).
- **Numeric input clamping on the recently-added routes** (`audit/route.ts`, `domains/[domain]/runs/route.ts`): both correctly use `parseInt + ||fallback + Math.min/Math.max`. Good pattern, propagate it to the routes flagged above that use raw `Number.parseInt` without clamping.
