# SSR Dashboard — Developer guide

Next.js 16 + TypeScript + SQLite. Strict mode, no `any` casts in business logic, 82-test Vitest suite, `0 npm-audit vulnerabilities`.

For deployment, see [`./DEPLOY.md`](./DEPLOY.md). For first-time install on Ubuntu, see [`../UBUNTU_INSTALL.md`](../UBUNTU_INSTALL.md). For the production audit and what was hardened, see [`../audit/SUMMARY.md`](../audit/SUMMARY.md).

---

## Local development

```bash
# Node 22.5+ required (uses built-in node:sqlite)
node --version       # must be v22.5.0 or higher

cd template_v0
npm ci

# Generate a session secret for local dev
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))")
cp .env.example .env.local
echo "SSR_SESSION_PASSWORD=$SECRET" >> .env.local

npm run dev          # http://localhost:3000 with Turbopack HMR
```

The dev server creates `../data/ssr.db` on first boot via `lib/init-schema.ts`. Wipe the file any time — the schema rebuilds on next start.

## Code layout

```
template_v0/
├── app/                       Next.js App Router
│   ├── (pages)/               UI routes — login, /domains, /servers, /cloudflare,
│   │                          /watcher, /logs, /audit, /settings, /ai-generator
│   └── api/                   Route handlers (~80 endpoints)
│       ├── auth/              login, logout
│       ├── domains/           CRUD + run-pipeline + run-from + bulk-* + import + override
│       ├── servers/           CRUD + create + destroy-all + sync-from-do
│       ├── cf-keys/           CRUD + bulk-add/delete/dns-csv/set-ip/set-settings + refresh-accounts
│       ├── cf-ai-keys/        CRUD for the Workers AI pool
│       ├── settings/          GET (redacted) / POST + master-prompt + test-llm-key
│       ├── sa/                ServerAvatar SSH actions — index-file, bulk-edit, upload-file,
│       │                      service-restart, reinstall-ssl, fleet
│       ├── ai-generator/      one-shot domain → live-site queue
│       └── system/            health, auto-heal-tick
│
├── lib/                       Business logic
│   ├── db.ts                  SQLite connection (cached on globalThis)
│   ├── init-schema.ts         CREATE TABLE + ALTER + indexes
│   ├── auth.ts                Werkzeug PBKDF2 verify, session helpers
│   ├── auth-config.ts         iron-session shape (Edge-safe, used by middleware)
│   ├── pipeline.ts            10-step state machine (~1200 LOC)
│   ├── jobs.ts                Durable job queue + 4-worker pool
│   ├── cloudflare.ts          CF REST client (zone, DNS, Origin CA, SSL)
│   ├── cf-key-pool.ts         CF DNS key pool + atomic slot allocation
│   ├── cf-ai-pool.ts          CF Workers AI pool (LRU rotation)
│   ├── digitalocean.ts        DO REST client + dual-token failover + cost cap
│   ├── serveravatar.ts        SA REST + SSH (ssh2)
│   ├── serveravatar-ui.ts     Patchright fallback for SSL install
│   ├── spaceship.ts           Registrar API (purchase, NS, contacts)
│   ├── website-generator.ts   LLM router (OpenAI/Anthropic/Gemini/Moonshot/CF) + content safety
│   ├── llm-cli.ts             Codex CLI shell-out path
│   ├── secrets-vault.ts       Fernet encryption (Python-compatible)
│   ├── notify.ts              Telegram + Email + WhatsApp + SMS
│   ├── live-checker.ts        Background HTTPS probes
│   ├── auto-heal.ts           5-min sweeper for stuck pipelines
│   ├── migration.ts           Domain migration to a different server
│   ├── backup.ts              Daily VACUUM INTO + Fernet-key copy
│   ├── log-retention.ts       Daily cleanup of pipeline_log / audit_log / pipeline_runs
│   ├── login-throttle.ts      In-memory IP-keyed login throttle
│   ├── concurrency.ts         Per-key semaphore
│   ├── request-ip.ts          Centralized XFF trust gate
│   └── repos/                 SQLite query layer (one file per table)
│       ├── domains.ts
│       ├── servers.ts
│       ├── cf-keys.ts
│       ├── cf-ai-keys.ts
│       ├── audit.ts
│       ├── logs.ts
│       ├── runs.ts
│       ├── settings.ts
│       └── steps.ts
│
├── components/                React UI components (Radix + Tailwind)
├── hooks/                     React hooks (useSWR wrappers)
├── tests/                     Vitest suite (15 files, 82 tests)
├── instrumentation.ts         Boot hooks: register handlers, start pool, SIGTERM
├── middleware.ts              Auth gate + CSRF Origin check (Edge runtime)
├── next.config.mjs            Security headers (CSP, HSTS, X-Frame-Options, ...)
└── package.json
```

## Tooling

| Command | What it does |
|---|---|
| `npm run dev` | Turbopack dev server, HMR, no production guards |
| `npm run build` | Production build, strict TS (`ignoreBuildErrors: false`) |
| `npm run start` | Run the prod build on port 3000 |
| `npm run lint` | ESLint over the project |
| `npm test` | Vitest (one shot, all 82 tests in <2s) |
| `npm run test:watch` | Vitest in watch mode |
| `npx tsc --noEmit` | Standalone typecheck (CI-friendly) |
| `npm audit --omit=dev` | CVE check for production deps |

## Adding a new feature

### A new API route

1. Create `app/api/<resource>/<verb>/route.ts` exporting `GET` / `POST` / etc.
2. Add `export const runtime = "nodejs"` (the default Edge runtime can't load `node:sqlite`).
3. Auth is automatic — middleware gates everything except the public allowlist (`/api/health`, `/api/auth/login`, `/login`, static assets).
4. Read input safely:
   ```ts
   const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
   ```
5. Validate every field — length cap, type check, enum check, shape regex. Don't trust JSON-parsed input.
6. For state-changing routes: call `appendAudit(action, target, detail, clientIp(req))` before returning success.

### A new repo

Add `lib/repos/<table>.ts` exporting:
- A typed `Row` interface
- A `COLS` set for write-side column allowlisting (mirrors Flask's `_DOMAIN_COLS` style)
- `list*`, `get*`, `add*`, `update*`, `delete*` helpers using `lib/db.ts`'s `all/one/run`

Use parameterized queries (`?` placeholders) — never string-concatenate user input into SQL.

### A new lib module that talks to an external API

Pattern (every module in `lib/` already follows this):

1. **Timeouts**: every `fetch` gets `signal: AbortSignal.timeout(30_000)`.
2. **Retries**: 2-attempt linear backoff on 429 / 5xx / network errors. NEVER auto-retry POSTs that have side effects unless you can guarantee idempotency (e.g. via a pre-check for "already exists").
3. **Failover** (where possible): primary → backup credential. See `lib/digitalocean.ts:doRequest` for the canonical pattern.
4. **JSON parse safety**: read body as text first, JSON.parse, surface a descriptive error on parse failure. See `lib/website-generator.ts:safeLlmJson`.

### A new pipeline step

Don't. The 10-step pipeline is stable. If you need a new automation, write it as a separate job kind in `lib/handlers/<kind>.ts` and enqueue from a route. Most "new step" requests are actually new bulk operations, which fit the existing handler pattern cleanly.

## Tests

```bash
npm test
```

The suite uses an isolated temp DB per test file (`tests/_setup.ts:setupTestDb`). The schema is created via the same `lib/init-schema.ts` prod uses on first boot — so test runs prove the schema bootstrap works end-to-end.

Add a test in `tests/<thing>.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

describe("my feature", () => {
  it("does the thing", async () => {
    const { myFn } = await import("@/lib/my-module")
    expect(myFn(1)).toBe(2)
  })
})
```

External-API calls in tests use `vi.fn()` for `global.fetch` — see `tests/cloudflare.test.ts` for the pattern. Don't hit real upstreams in unit tests.

## Common gotchas

- **`node:sqlite` requires Node 22.5+**. Earlier versions silently fall back to whatever `sqlite3` package is installed, which won't work.
- **Don't `npm install`** — use `npm ci`. The lockfile is the source of truth.
- **Turbopack ≠ webpack**. Don't add webpack-specific config to `next.config.mjs`.
- **`patchright` packages**: marked as serverExternalPackages in `next.config.mjs` because Turbopack's static analysis can't follow their dynamic imports.
- **Middleware runs on Edge runtime**: don't import `node:sqlite` / `node:fs` / anything Node-only into `middleware.ts`. Keep it to iron-session + Web APIs.
- **`appendAudit` is synchronous** (writes to SQLite). Cheap, but don't put it before a fast 304 path — the write is the only place the actor IP gets recorded.

## Production-readiness checklist

Before deploying changes that touch external APIs, run through:

- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] `npm audit --omit=dev` is clean
- [ ] If touching state-changing routes: audit-log entry added
- [ ] If touching pipeline steps: idempotency verified (rerun produces same result)
- [ ] If touching SSH/SQL/shell: every interpolated value is allowlisted or shape-validated
- [ ] If touching cookies/auth: `sameSite=strict`, `httpOnly`, `secure` (in prod) all preserved
- [ ] If adding a job kind: `registerHandler` wired in `instrumentation.ts`

## Schema

Owned end-to-end by [`lib/init-schema.ts`](./lib/init-schema.ts). Every `CREATE TABLE` runs on first connection (idempotent via `IF NOT EXISTS`). Legacy column adds use a `tryAlter()` helper that swallows "duplicate column" errors so re-running on a populated DB is safe.

To add a column:

1. Add it to the `CREATE TABLE` statement in `init-schema.ts`.
2. Add a `tryAlter(db, "ALTER TABLE foo ADD COLUMN bar ...")` line in `applyMigrations()`.
3. Add the field to the typed `Row` interface in `lib/repos/<table>.ts`.
4. Add the column name to the `COLS` allowlist if it's writable.

Never add a destructive migration (DROP / RENAME). Only add columns or new tables.

## License

Proprietary. Single-operator use only.
