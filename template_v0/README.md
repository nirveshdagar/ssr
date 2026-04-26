# SSR Dashboard — Next.js port (in progress)

Sibling project to the Flask dashboard at `../`. Both apps read and write
the **same** SQLite file at `../data/ssr.db`, so this can be developed
incrementally — pages move over one at a time without splitting state.

## Run locally

```bash
cd template_v0
pnpm install        # (or npm install / yarn)
pnpm dev            # http://localhost:3000
```

Login uses the same `dashboard_password_hash` as the Flask app
(werkzeug PBKDF2 format). Set the password once via Flask Settings page
or by running the Flask `/login` flow; the Next.js side will accept it.

## What's done

- **Design system**: full v0-generated tokens in `app/globals.css`
  (light + dark, per-page accents, badges, cards, sidebar/topbar).
- **Database layer** (`lib/db.ts`, `lib/repos/*`): better-sqlite3 wrapper,
  type-safe repos for domains / servers / cf_keys / pipeline_runs /
  audit_log / pipeline_log. Same column whitelist as Flask's
  `_DOMAIN_COLS` / `_SERVER_COLS` so a Next.js write can never touch
  an unintended column.
- **Auth** (`lib/auth.ts`, `middleware.ts`):
  - iron-session cookie (8h, httpOnly, sameSite=lax)
  - Werkzeug PBKDF2 verify (`pbkdf2:sha256:<iters>$<salt>$<hex>`) +
    legacy plaintext-fallback that mirrors Flask's transparent migration
  - `middleware.ts` gates everything except /login + /api/auth/login +
    /api/health
  - 401 JSON for `/api/*`, redirect for page paths
- **API routes** (read + light-touch write):
  - `POST /api/auth/login`  — verifies password, sets session cookie
  - `POST /api/auth/logout` — clears session
  - `GET  /api/health`      — no-auth probe
  - `GET  /api/domains` (with `q=` multi-token bulk-list filter,
    `status=` filter — same behavior as Flask `/domains` route)
  - `POST /api/domains`     — add one or many (comma/newline separated)
  - `GET  /api/domains/[domain]`         — single row
  - `DELETE /api/domains/[domain]`       — soft delete (releases CF slot)
  - `GET  /api/domains/[domain]/runs`    — pipeline_runs history
  - `GET  /api/runs/[id]`   — run + step_runs detail
  - `GET  /api/servers`
  - `GET  /api/servers/[id]`
  - `DELETE /api/servers/[id]` — soft delete
  - `PATCH /api/servers/[id]`  — edit name + max_sites
  - `GET  /api/cf-keys`        — keys with masked previews + domains-per-key
  - `GET  /api/cf-keys/[id]`
  - `DELETE /api/cf-keys/[id]`
  - `PATCH /api/cf-keys/[id]`  — `action=toggle` or edit
  - `GET  /api/audit`          — search/filter/paginate audit_log
  - `GET  /api/logs`           — pipeline_log tail
- All audit-trail writes go through `appendAudit()` so the same
  `audit_log` table both apps share stays consistent.

## What's NOT ported (deliberate)

These touch real upstreams (CF / DO / SA / Spaceship / LLM / SSH) and
need careful translation that goes well beyond CRUD. The Flask app keeps
running them; the Next.js side can hand off to Flask via fetch in the
interim, or wait for a proper port.

| Subsystem | Flask source | Why deferred |
|---|---|---|
| Cloudflare API client | `modules/cloudflare_api.py` (~600 lines) | Zone CRUD + DNS records + zone settings + Origin CA cert. ~25 endpoints with retry/backoff. Real port. |
| DigitalOcean | `modules/digitalocean.py` | Droplet provision/destroy/list + token failover + cost-cap. |
| ServerAvatar | `modules/serveravatar.py` (~1100 lines) | App CRUD + SSL install via SSH (paramiko); no first-class Node SSH equivalent. Hardest module to port. |
| Spaceship | `modules/spaceship.py` | Domain registrar API. Straightforward when we get there. |
| Website generator (LLM) | `modules/website_generator.py` | Anthropic SDK + content safety scan. Doable in Node. |
| Migration | `modules/migration.py` | Tarball archive + cf record patching for dead-server migration. |
| Job queue + workers | `modules/jobs.py` (~310 lines) + 4-thread pool | Need to pick a Node queue (BullMQ + Redis vs better-queue vs in-process) and rewrite. |
| Pipeline orchestrator | `modules/pipeline.py` (~900 lines) | The 10-step state machine. Depends on every module above. |
| Notify / alerts | `modules/notify.py` | Telegram + WhatsApp + SMTP + Slack. |
| Live checker | `modules/live_checker.py` | Background HTTPS probe loop. |
| CF key pool | `modules/cf_key_pool.py` | Slot allocation logic. |
| Bulk action endpoints | several in `app.py` | bulk-set-ip / bulk-set-settings / bulk-dns-csv / sync-from-do / sync-from-sa — depend on the modules above. |
| Pipeline trigger endpoints | `/api/domains/<d>/run-pipeline`, `run-from`, `run-bulk`, `cancel-pipeline`, `override-field` | Need the pipeline orchestrator first. |
| Settings page panels | `app.py:settings()` | Lots of fields, encryption-at-rest via Fernet (uses `cryptography` lib — works in Node via `crypto` but needs careful key migration). |
| Background sweeps | `_grey_cloud_recovery`, `_orphan_droplet_sweep` | Need the CF + DO ports first. |
| Tests | 249 pytest cases | Will rewrite in vitest as we port each module. |

## Page status

- All 8 pages from v0 are present (login / dashboard / domains / servers /
  cloudflare / watcher / logs / audit / settings) but currently use mock
  data from `lib/ssr/mock-data.ts`. Wiring them to the real APIs above
  is the next step — easy mechanical work, just hadn't fit in this turn.
- The Flask UI at `../templates/` continues to be the primary, full-
  featured operator surface until each page is ported.

## Adding a new page-level API call

1. Add a repo helper in `lib/repos/<table>.ts` if missing.
2. Add a route in `app/api/<resource>/route.ts` returning JSON.
3. In the page client component, replace the mock import with `useSWR("/api/...")`.
4. Confirm the auth gate works (middleware should already cover it).
