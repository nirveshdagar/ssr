# SSR Dashboard

**Self-hosted control plane for running a fleet of SEO / affiliate / lead-gen domains end-to-end.** Buy a domain, point it at Cloudflare, provision a DigitalOcean droplet, install ServerAvatar, issue an SSL cert, generate the site with an LLM, deploy to `public_html` — all 10 steps, automated, audited, recoverable.

Built for a single operator. No SaaS tier. No marketplace. Your accounts, your servers, your DB.

[![License](https://img.shields.io/badge/license-Proprietary-blue)]() [![Stack](https://img.shields.io/badge/stack-Next.js%2016%20%7C%20SQLite-black)]() [![Status](https://img.shields.io/badge/status-Production-success)]() [![Tests](https://img.shields.io/badge/tests-82%20passing-success)]() [![CVEs](https://img.shields.io/badge/npm%20audit-0-success)]()

---

## What it does

| Stage | Step | Powered by |
|---|---|---|
| **Acquire** | 1. Purchase domain or detect existing | Spaceship registrar API |
| **Network** | 2. Assign Cloudflare API key from a multi-account pool | CF DNS Global Keys |
| | 3. Create Cloudflare zone | CF API |
| | 4. Switch nameservers at registrar | Spaceship API |
| | 5. Wait for zone to go active (DNS propagation) | CF zone-status poll |
| **Host** | 6. Provision DigitalOcean droplet + install ServerAvatar agent | DO API + cloud-init + ServerAvatar |
| | 7. Create SA application + A records | ServerAvatar REST + CF DNS |
| | 8. Issue & install Cloudflare Origin CA SSL cert (15-year) | CF Origin CA + ServerAvatar SSH |
| **Content** | 9. Generate single-page site via LLM | OpenAI / Anthropic / Gemini / Moonshot / CF Workers AI pool |
| | 10. Upload `index.php` (or multi-file site) to `public_html` | ServerAvatar SFTP |

Once a domain hits step 10, it's live behind Cloudflare with a real cert and a real site. Repeat for the next 50.

## Why you might want this

- **Account scaling built in** — Cloudflare DNS Global Keys pool, CF Workers AI key pool (free 10k neurons/day stacked across many accounts), DigitalOcean primary → backup token failover, ServerAvatar primary → backup failover. One operator, many accounts.
- **Crash-safe** — durable job queue in SQLite, per-step locks so retries don't redo completed work, auto-heal sweeper that resumes stuck pipelines every 5 minutes, idempotent DO droplet creates, SIGTERM-safe shutdown drains in-flight jobs.
- **Encrypted secrets at rest** — Fernet vault (compatible with Python's `cryptography` library) protects every API key, password, and CF Global Key in the database.
- **Live-checker** — background HTTPS probes flip domain status `live ↔ hosted` based on real-world reachability; dead-server detector can auto-migrate sites to a fresh droplet.
- **Multi-channel alerts** — Telegram, email, WhatsApp (greenapi), SMS (Twilio) — wired to pipeline failures, dead servers, all-tokens-failed events.
- **Audit log + 90-day retention** — every state-changing API call is recorded; old logs auto-rotate so the table doesn't bloat at 10k+ rows.
- **AI generator page** — paste a list of domains, optionally tweak provider/model/brief, queue them for sequential rollout. Or use the parallel path for max throughput.

## Built for one operator

Single-user by design — there's no SSO, no signup, no recovery flow. One dashboard password, one Fernet key file, one SQLite DB.

If you want a multi-tenant SaaS, this isn't that. If you want a private cockpit for your own fleet, you're in the right place.

## Tech stack

- **Frontend / API**: [Next.js 16](https://nextjs.org/) (App Router) + React 19 + TypeScript (strict, `ignoreBuildErrors: false`)
- **Database**: SQLite (Node 22+ built-in `node:sqlite` — no native build, no MSVC toolchain) with WAL mode
- **Auth**: [iron-session](https://github.com/vvo/iron-session) cookie (httpOnly, sameSite=strict, 8h)
- **SSH / SFTP**: [ssh2](https://github.com/mscdex/ssh2)
- **Browser automation fallback**: [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (used only when the SA REST API can't install an SSL cert)
- **LLMs**: OpenAI Codex CLI, Anthropic Messages API, Gemini, OpenRouter, Moonshot, Cloudflare Workers AI (single + pooled across many accounts)
- **Test runner**: [Vitest](https://vitest.dev/) — 82 tests, runs in <2s

## Quick start

> Detailed Ubuntu deployment instructions: [`UBUNTU_INSTALL.md`](./UBUNTU_INSTALL.md)
> Production deploy & operations: [`template_v0/DEPLOY.md`](./template_v0/DEPLOY.md)

```bash
# 1. Clone
git clone https://github.com/nirveshdagar/ssr.git
cd ssr/template_v0

# 2. Install (Node 22+ required)
npm ci
npx patchright install chromium    # optional — only for SA UI fallback

# 3. Configure
cp .env.example .env.local
# Edit .env.local — set SSR_SESSION_PASSWORD to a 32+ byte random string:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# 4. Build & run
npm run build
npm run start                      # http://localhost:3000
```

First time you load the dashboard, set the operator password in **Settings → Security**, then add your Cloudflare keys, DO tokens, ServerAvatar credentials, Spaceship API key, and at least one LLM provider key.

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser  ── HTTPS ──>  Reverse proxy (nginx/Caddy)             │
│                              │                                  │
│                              ▼                                  │
│                    Next.js process (Node 22)                    │
│                    ├── App Router pages (UI)                    │
│                    ├── /api/* route handlers                    │
│                    ├── In-process job pool (4 workers default)  │
│                    ├── Auto-heal sweeper (5 min)                │
│                    ├── Live-checker (opt-in)                    │
│                    ├── Daily DB backup (VACUUM INTO)            │
│                    └── Daily log retention                      │
│                              │                                  │
│                              ▼                                  │
│                    SQLite (data/ssr.db, WAL)                    │
│                    + Fernet key file (data/.ssr_secret_fernet)  │
│                              │                                  │
│  External APIs (with primary→backup failover where applicable): │
│    Cloudflare · DigitalOcean · ServerAvatar · Spaceship         │
│    OpenAI · Anthropic · Gemini · Moonshot · OpenRouter · CF AI  │
│    Twilio · Telegram · GreenAPI · SMTP                          │
└─────────────────────────────────────────────────────────────────┘
```

## Repository layout

```
ssr/
├── README.md              ← you are here
├── UBUNTU_INSTALL.md      ← step-by-step Ubuntu deployment
├── audit/                 ← production-readiness audit reports
│   ├── SUMMARY.md         ← consolidated triaged findings
│   ├── security.md
│   ├── data-concurrency.md
│   ├── failure-observability.md
│   └── validation-tests-deps.md
├── data/                  ← SQLite DB + Fernet key (gitignored)
└── template_v0/           ← the application
    ├── app/               ← Next.js App Router pages + API routes
    ├── components/        ← React UI components
    ├── lib/               ← business logic (auth, pipeline, CF, DO, SA, ...)
    ├── tests/             ← Vitest test suite
    ├── DEPLOY.md          ← deployment + operations guide
    └── package.json
```

## Production-readiness

This codebase has been through a 9-wave production-readiness audit (waves 1-9 in `audit/SUMMARY.md`). Closed:

- **5/5 P0 blockers** — DO droplet idempotency, bulk-endpoint caps, daily DB backup, SIGTERM handling, pipeline-failure alerting wired up
- **22/24 P1 must-fix** — secrets-at-rest encryption, CSRF defense (sameSite=strict + Origin check), shell-injection hardening, external-API timeouts/retries, concurrency races
- **17/24 P2** — security headers (CSP/HSTS/X-Frame-Options), server-IP allowlist on SSH routes, log retention, transactions on multi-write blocks
- **9/13 P3** — index migrations, dead-code removal, mock-data cleanup

Result: **0 npm-audit vulnerabilities**, 82/82 tests pass, typecheck clean under `strict: true` + `ignoreBuildErrors: false`.

## Documentation

| Doc | Audience |
|---|---|
| [`UBUNTU_INSTALL.md`](./UBUNTU_INSTALL.md) | First-time deployment to a fresh Ubuntu server |
| [`template_v0/DEPLOY.md`](./template_v0/DEPLOY.md) | Operations: systemd, nginx, backups, retention, env vars |
| [`template_v0/README.md`](./template_v0/README.md) | Developer guide: code layout, adding features, API surface |
| [`audit/SUMMARY.md`](./audit/SUMMARY.md) | Production audit findings and what was closed |

## License

Proprietary — single-operator use. No redistribution.

## Author

Built and operated by [@nirveshdagar](https://github.com/nirveshdagar).
