"use client"

import * as React from "react"
import {
  Server as ServerIcon,
  Cloud,
  Rocket,
  Sparkles,
  ShieldCheck,
  Globe,
  KeyRound,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  Loader2,
  ExternalLink,
  ShieldPlus,
  LogOut,
  Send,
  ArrowLeftRight,
  Terminal,
  Megaphone,
  Mail,
  MessageCircle,
  Phone,
  Search,
  Radio,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useSettings, saveSettings, type SettingsValues } from "@/hooks/use-settings"
import { domainActions } from "@/lib/api-actions"
import { CfAiPoolCard } from "@/components/ssr/cf-ai-pool-card"
import { ModelPicker } from "@/components/ssr/model-picker"
import { LLM_PROVIDER_OPTIONS } from "@/lib/llm-models"
import { MasterPromptCard } from "@/components/ssr/master-prompt-card"

// Section icon tints — pulled straight from the per-page-accent CSS vars so
// every section reads in the same SaaSflow palette as the rest of the app.
// No hardcoded hex anywhere; dark mode adapts automatically because the
// underlying tokens shift in :root vs .dark.
const SECTIONS = [
  { id: "spaceship", label: "Spaceship",    icon: Rocket,         tint: { bg: "var(--page-dashboard)",  text: "var(--page-dashboard)"  } }, // royal blue
  { id: "do",        label: "DigitalOcean", icon: Cloud,          tint: { bg: "var(--page-servers)",    text: "var(--page-servers)"    } }, // sky
  { id: "sa",        label: "ServerAvatar", icon: ServerIcon,     tint: { bg: "var(--page-domains)",    text: "var(--page-domains)"    } }, // green
  { id: "llm",       label: "LLM",          icon: Sparkles,       tint: { bg: "var(--page-watcher)",    text: "var(--page-watcher)"    } }, // lighter royal blue
  { id: "cf",        label: "Cloudflare",   icon: Globe,          tint: { bg: "var(--page-cloudflare)", text: "var(--page-cloudflare)" } }, // yellow — matches /cloudflare
  { id: "server",    label: "Server SSH",   icon: Terminal,       tint: { bg: "var(--page-settings)",   text: "var(--page-settings)"   } }, // slate
  { id: "alerts",    label: "Alerts",       icon: Megaphone,      tint: { bg: "var(--page-audit)",      text: "var(--page-audit)"      } }, // orange-red — alarm tone
  { id: "migrate",   label: "Migration",    icon: ArrowLeftRight, tint: { bg: "var(--page-logs)",       text: "var(--page-logs)"       } }, // deep navy — diagnostic
  { id: "security",  label: "Security",     icon: ShieldCheck,    tint: { bg: "var(--destructive)",     text: "var(--destructive)"     } }, // orange-red — security
] as const

type SectionId = typeof SECTIONS[number]["id"]
type FormState = Partial<SettingsValues>

interface ProviderInfo {
  id: "anthropic" | "openai" | "gemini" | "openrouter" | "moonshot"
  label: string
  prefix: string
  url: string
  consoleName: string
  modelExample: string
  /** Name of the CLI binary that does its own OAuth login. When present,
   *  the row gets an install + sign-in panel that bypasses the API key. */
  cli?: {
    bin: string
    /** Verb shown on the Sign-in button — varies per provider since they
     *  use different identity providers (Google vs ChatGPT). */
    loginLabel: string
    cliKey: keyof SettingsValues
  }
}

const LLM_PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic key",
    prefix: "sk-ant-api03-…",
    url: "https://console.anthropic.com/settings/keys",
    consoleName: "Anthropic Console",
    modelExample: "claude-haiku-4-5-20251001",
  },
  {
    id: "openai",
    label: "OpenAI key",
    prefix: "sk-proj-… or sk-…",
    url: "https://platform.openai.com/api-keys",
    consoleName: "OpenAI Platform",
    modelExample: "gpt-5.4-mini",
    cli: {
      bin: "codex",
      loginLabel: "Sign in with ChatGPT",
      cliKey: "llm_cli_enabled_openai",
    },
  },
  {
    // Gemini: API key only. The CLI direct-OAuth panel was removed because
    // gemini-cli ≥ 0.38 hard-rejects non-interactive OAuth and the workaround
    // (dashboard-handled OAuth writing oauth_creds.json) didn't reliably work
    // across CLI version bumps. Operators paste an AI Studio API key instead
    // — same free quota, none of the spawn / browser-redirect fragility.
    id: "gemini",
    label: "Gemini key",
    prefix: "AIza…",
    url: "https://aistudio.google.com/apikey",
    consoleName: "Google AI Studio",
    modelExample: "gemini-2.5-flash",
  },
  {
    id: "openrouter",
    label: "OpenRouter key",
    prefix: "sk-or-v1-…",
    url: "https://openrouter.ai/keys",
    consoleName: "OpenRouter",
    modelExample: "google/gemini-2.5-flash",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi key",
    prefix: "sk-…",
    url: "https://platform.moonshot.ai/console/api-keys",
    consoleName: "Moonshot Platform",
    modelExample: "kimi-k2.6",
  },
]

export default function SettingsPage() {
  const { settings, isLoading, mutate } = useSettings()
  const [active, setActive] = React.useState<SectionId>("spaceship")
  const [form, setForm] = React.useState<FormState>({})
  const [saving, setSaving] = React.useState(false)
  const [savedAt, setSavedAt] = React.useState<Date | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }
  function get<K extends keyof SettingsValues>(key: K): SettingsValues[K] | undefined {
    return form[key]
  }

  async function onSave() {
    setSaving(true); setErr(null)
    try {
      const patch = { ...form }
      delete (patch as Record<string, unknown>).has_password
      delete (patch as Record<string, unknown>).do_last_working_token
      await saveSettings(patch)
      setSavedAt(new Date())
      await mutate()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (isLoading || !settings) {
    return (
      <AppShell title="Settings" description="Loading…" breadcrumbs={[{ label: "Settings" }]} accent="settings">
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </AppShell>
    )
  }

  const lastWorkingToken = settings.do_last_working_token

  return (
    <AppShell
      title="Settings & API Keys"
      description="Configure all service credentials. Stored locally in your database."
      breadcrumbs={[{ label: "Settings" }]}
      accent="settings"
      actions={
        settings.has_password ? <LogoutButton /> : null
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        <aside className="lg:sticky lg:top-[120px] lg:self-start">
          <nav aria-label="Settings sections">
            <ul className="flex flex-col gap-0.5">
              {SECTIONS.map((s) => {
                const isActive = active === s.id
                const Icon = s.icon
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => {
                        setActive(s.id)
                        document.getElementById(`settings-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors",
                        isActive
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                      title={`Jump to ${s.label} settings`}
                    >
                      <Icon
                        className="h-3.5 w-3.5"
                        style={{ color: isActive ? s.tint.text : undefined }}
                      />
                      {s.label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
        </aside>

        <div className="flex flex-col gap-4 pb-20">
          {/* ---------------- Spaceship ---------------- */}
          <SettingsSection
            id="spaceship" title="Spaceship" subtitle="Domain Registrar"
            description="Registrar credentials + WHOIS contact (used at step 1 of the pipeline if Skip-purchase is off)."
            icon={Rocket} tint={SECTIONS[0].tint}
          >
            <FieldGroup>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>API key</FieldLabel>
                  <SecretInput value={get("spaceship_api_key") ?? ""} onChange={(v) => set("spaceship_api_key", v)} placeholder="X-Api-Key" />
                </Field>
                <Field>
                  <FieldLabel>API secret</FieldLabel>
                  <SecretInput value={get("spaceship_api_secret") ?? ""} onChange={(v) => set("spaceship_api_secret", v)} placeholder="X-Api-Secret" />
                </Field>
              </div>
              <div className="border-t border-border/60 pt-3">
                <p className="text-micro text-muted-foreground mb-2">
                  Registrant info — used as the WHOIS contact when buying a new domain.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field>
                    <FieldLabel>First name</FieldLabel>
                    <Input value={get("registrant_first_name") ?? ""} onChange={(e) => set("registrant_first_name", e.target.value)} placeholder="John" />
                  </Field>
                  <Field>
                    <FieldLabel>Last name</FieldLabel>
                    <Input value={get("registrant_last_name") ?? ""} onChange={(e) => set("registrant_last_name", e.target.value)} placeholder="Doe" />
                  </Field>
                  <Field>
                    <FieldLabel>Email</FieldLabel>
                    <Input type="email" value={get("registrant_email") ?? ""} onChange={(e) => set("registrant_email", e.target.value)} placeholder="you@email.com" />
                  </Field>
                  <Field>
                    <FieldLabel>Phone</FieldLabel>
                    <Input value={get("registrant_phone") ?? ""} onChange={(e) => set("registrant_phone", e.target.value)} placeholder="+1.5551234567" />
                  </Field>
                  <Field className="sm:col-span-2">
                    <FieldLabel>Address</FieldLabel>
                    <Input value={get("registrant_address") ?? ""} onChange={(e) => set("registrant_address", e.target.value)} placeholder="123 Main St" />
                  </Field>
                  <Field>
                    <FieldLabel>City</FieldLabel>
                    <Input value={get("registrant_city") ?? ""} onChange={(e) => set("registrant_city", e.target.value)} placeholder="New York" />
                  </Field>
                  <Field>
                    <FieldLabel>State</FieldLabel>
                    <Input value={get("registrant_state") ?? ""} onChange={(e) => set("registrant_state", e.target.value)} placeholder="NY" />
                  </Field>
                  <Field>
                    <FieldLabel>ZIP</FieldLabel>
                    <Input value={get("registrant_zip") ?? ""} onChange={(e) => set("registrant_zip", e.target.value)} placeholder="10001" />
                  </Field>
                  <Field>
                    <FieldLabel>Country</FieldLabel>
                    <Input value={get("registrant_country") ?? ""} onChange={(e) => set("registrant_country", e.target.value)} placeholder="US" />
                  </Field>
                </div>
              </div>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- DigitalOcean ---------------- */}
          <SettingsSection
            id="do" title="DigitalOcean" subtitle="Server hosting — with backup-token failover"
            description={
              lastWorkingToken
                ? `Last working token: ${lastWorkingToken}`
                : "On 401/403/5xx/timeout from primary, the runtime auto-falls-back to the backup."
            }
            icon={Cloud} tint={SECTIONS[1].tint}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>Primary API token</FieldLabel>
                <SecretInput value={get("do_api_token") ?? ""} onChange={(v) => set("do_api_token", v)} placeholder="Personal Access Token" />
              </Field>
              <Field>
                <FieldLabel>
                  <span className="inline-flex items-center gap-1.5">
                    Backup API token
                    <span className="rounded bg-status-waiting/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-waiting">
                      failover
                    </span>
                  </span>
                </FieldLabel>
                <SecretInput value={get("do_api_token_backup") ?? ""} onChange={(v) => set("do_api_token_backup", v)} placeholder="Fallback PAT (second DO account recommended)" />
                <FieldDescription>
                  Used automatically on 401/403/5xx/timeout from the primary. Put a PAT from a{" "}
                  <strong>different DO account</strong> here for account-level disaster-recovery.
                </FieldDescription>
              </Field>
              <ToggleRow
                title="Use backup FIRST (skip primary)"
                description="Reverses the order — flip this when you know the primary is broken so the runtime stops banging on it."
                checked={get("do_use_backup_first") ?? false}
                onChange={(v) => set("do_use_backup_first", v)}
              />
              <DoTestButton
                primary={get("do_api_token") ?? ""}
                backup={get("do_api_token_backup") ?? ""}
              />
              <Field>
                <FieldLabel>
                  <span className="inline-flex items-center gap-1.5">
                    Domains per server (default cap)
                    <span className="rounded bg-status-running/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-running">
                      provisioning trigger
                    </span>
                  </span>
                </FieldLabel>
                <Input
                  type="number" min={1} max={500}
                  value={get("sites_per_server") ?? ""}
                  onChange={(e) => set("sites_per_server", e.target.value)}
                  placeholder="60"
                />
                <FieldDescription>
                  Default <code className="font-mono">max_sites</code> stamped on every newly-provisioned
                  droplet. When all eligible servers reach this cap, the pipeline provisions a fresh one
                  for the next domain. Per-server overrides remain editable on the Servers page (⋯ →
                  Edit). Only affects NEW servers added after this change — existing rows keep their
                  current cap.
                </FieldDescription>
              </Field>

              {/* Default droplet region + size — used by:
                    • /servers → "New droplet" dialog (pre-fills both fields)
                    • migration (manual + auto) when the operator doesn't
                      override on the bulk-migrate dialog
                    • any handler that enqueues server.create without an
                      explicit region/size in the payload
                  Empty = legacy hardcode (nyc1 / s-1vcpu-1gb for /api/servers/create,
                  s-2vcpu-4gb for SA-driven create). */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>
                    <span className="inline-flex items-center gap-1.5">
                      Default region
                      <span className="rounded bg-status-running/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-running">
                        new + migrate
                      </span>
                    </span>
                  </FieldLabel>
                  <Select
                    value={get("do_default_region") || "__default__"}
                    onValueChange={(v) => set("do_default_region", v === "__default__" ? "" : v)}
                  >
                    <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">(leave blank — uses nyc1)</SelectItem>
                      <SelectItem value="nyc1">NYC1 — New York 1</SelectItem>
                      <SelectItem value="nyc3">NYC3 — New York 3</SelectItem>
                      <SelectItem value="sfo3">SFO3 — San Francisco 3</SelectItem>
                      <SelectItem value="ams3">AMS3 — Amsterdam 3</SelectItem>
                      <SelectItem value="lon1">LON1 — London 1</SelectItem>
                      <SelectItem value="fra1">FRA1 — Frankfurt 1</SelectItem>
                      <SelectItem value="tor1">TOR1 — Toronto 1</SelectItem>
                      <SelectItem value="sgp1">SGP1 — Singapore 1</SelectItem>
                      <SelectItem value="blr1">BLR1 — Bangalore 1</SelectItem>
                      <SelectItem value="syd1">SYD1 — Sydney 1</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Falls through to <code className="font-mono">nyc1</code> if blank. Override on
                    the New droplet / Bulk migrate dialog as needed.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel>Default size</FieldLabel>
                  <Select
                    value={get("do_default_size") || "__default__"}
                    onValueChange={(v) => set("do_default_size", v === "__default__" ? "" : v)}
                  >
                    <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__">(leave blank — uses s-1vcpu-1gb)</SelectItem>
                      <SelectItem value="s-1vcpu-1gb">s-1vcpu-1gb · $4/mo · smoke test</SelectItem>
                      <SelectItem value="s-1vcpu-2gb">s-1vcpu-2gb · $7/mo</SelectItem>
                      <SelectItem value="s-2vcpu-2gb">s-2vcpu-2gb · $9/mo</SelectItem>
                      <SelectItem value="s-2vcpu-4gb">s-2vcpu-4gb · $14/mo</SelectItem>
                      <SelectItem value="s-2vcpu-4gb-amd">s-2vcpu-4gb-amd · $16/mo · AMD</SelectItem>
                      <SelectItem value="s-2vcpu-8gb-160gb-intel">s-2vcpu-8gb-160gb-intel · $24/mo · prod default</SelectItem>
                      <SelectItem value="s-4vcpu-8gb">s-4vcpu-8gb · $36/mo</SelectItem>
                      <SelectItem value="s-4vcpu-16gb">s-4vcpu-16gb · $56/mo</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Falls through to <code className="font-mono">s-1vcpu-1gb</code> for the New
                    droplet button and <code className="font-mono">s-2vcpu-4gb</code> for SA-driven
                    create when blank. The Servers page New droplet dialog pre-fills with this value.
                  </FieldDescription>
                </Field>
              </div>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- ServerAvatar ---------------- */}
          <SettingsSection
            id="sa" title="ServerAvatar" subtitle="Panel Management"
            description="Bearer token for the SA API + dashboard credentials for the UI-automation SSL fallback."
            icon={ServerIcon} tint={SECTIONS[2].tint}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>API key (Bearer)</FieldLabel>
                <SecretInput value={get("serveravatar_api_key") ?? ""} onChange={(v) => set("serveravatar_api_key", v)} placeholder="Bearer token" />
              </Field>
              <Field>
                <FieldLabel>Organization ID</FieldLabel>
                <Input value={get("serveravatar_org_id") ?? ""} onChange={(e) => set("serveravatar_org_id", e.target.value)} placeholder="Org ID" />
              </Field>
              <Field>
                <FieldLabel>Backup API key (Bearer) — failover</FieldLabel>
                <SecretInput
                  value={get("serveravatar_api_key_backup") ?? ""}
                  onChange={(v) => set("serveravatar_api_key_backup", v)}
                  placeholder="Optional — used if primary returns 401/403/429/5xx or times out"
                />
                <FieldDescription>
                  Optional. Mirrors the DO backup-token pattern: if the primary SA account is rate-limited
                  or suspended mid-migration, calls automatically retry on this token. Leave blank to
                  disable failover.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Backup Organization ID</FieldLabel>
                <Input
                  value={get("serveravatar_org_id_backup") ?? ""}
                  onChange={(e) => set("serveravatar_org_id_backup", e.target.value)}
                  placeholder="Optional — defaults to primary org id if blank"
                />
              </Field>
              <div className="rounded-md border border-status-running/25 bg-status-running/8 px-3 py-2 text-small text-status-running">
                Dashboard login is only used by the UI-automated SSL install fallback (when SA&apos;s{" "}
                <code className="font-mono">/ssl</code> API returns 500). Both fields can stay blank if you don&apos;t need that path.
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Dashboard email</FieldLabel>
                  <Input
                    type="email" autoComplete="off"
                    value={get("sa_dashboard_email") ?? ""}
                    onChange={(e) => set("sa_dashboard_email", e.target.value)}
                    placeholder="you@example.com"
                  />
                </Field>
                <Field>
                  <FieldLabel>Dashboard password</FieldLabel>
                  <SecretInput
                    autoComplete="new-password"
                    value={get("sa_dashboard_password") ?? ""}
                    onChange={(v) => set("sa_dashboard_password", v)}
                    placeholder="dashboard password"
                  />
                </Field>
              </div>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- LLM ---------------- */}
          <SettingsSection
            id="llm" title="LLM" subtitle="Website Generator"
            description="Provider + model used at step 9 to draft each domain's homepage. Per-provider keys are validated independently."
            icon={Sparkles} tint={SECTIONS[3].tint}
          >
            <FieldGroup>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Default LLM provider for site generation</FieldLabel>
                  <Select value={get("llm_provider") || "anthropic"} onValueChange={(v) => set("llm_provider", v)}>
                    <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LLM_PROVIDER_OPTIONS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Used by step 9 (LLM site generation) on every new domain pipeline. Each
                    Run-pipeline / Bulk-run / Regenerate dialog can override this for a single
                    run if your default provider's API key is rate-limited or down.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Default model</FieldLabel>
                  <ModelPicker
                    provider={get("llm_provider") || "anthropic"}
                    value={get("llm_model") ?? ""}
                    onChange={(v) => set("llm_model", v)}
                  />
                  <FieldDescription>
                    Lists the most common models for the active provider. Pick
                    {" "}<em>(use provider default)</em>{" "}to clear the override and let the per-provider default kick in
                    (e.g. <code className="font-mono">claude-haiku-4-5-20251001</code> for Anthropic), or
                    {" "}<em>(custom)</em>{" "}to type a model id not in the list (fine-tuned variants, brand-new models).
                  </FieldDescription>
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Max output tokens</FieldLabel>
                  <Input
                    type="number" min={1000} max={64000} step={1000}
                    value={get("llm_max_output_tokens") ?? ""}
                    onChange={(e) => set("llm_max_output_tokens", e.target.value)}
                    placeholder="8000 (default)"
                    className="font-mono text-small"
                  />
                  <FieldDescription>
                    Cap on what step 9 can <em>generate</em> in one call (input briefs aren't
                    affected — those go up to the model's context window). Default{" "}
                    <code className="font-mono">8000</code> covers a fat single-page or 5-6 small files.
                    Auto-bumped to <strong>12 000</strong> when the brief is &gt;800 chars (multi-file intent),
                    and to <strong>16 000</strong> for reasoning models (K2.6, DeepSeek R1) regardless.
                    Bump to <code className="font-mono">32000</code> if the model truncates with <code>finish_reason=length</code>.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Generation timeout (ms)</FieldLabel>
                  <Input
                    type="number" min={30000} max={900000} step={30000}
                    value={get("llm_timeout_ms") ?? ""}
                    onChange={(e) => set("llm_timeout_ms", e.target.value)}
                    placeholder="300000 (5 min default)"
                    className="font-mono text-small"
                  />
                  <FieldDescription>
                    Per-LLM-call HTTP timeout. Reasoning models (K2.6, R1) often spend
                    60–120 s on chain-of-thought before the first token. Bump to{" "}
                    <code className="font-mono">600000</code> (10 min) for very long briefs.
                    Min 30 s, max 15 min.
                  </FieldDescription>
                </Field>
              </div>

              {/* Per-provider keys — each with its own Test button + console link.
                  Providers with a CLI also get a "Use local CLI auth" toggle that
                  bypasses the API key and shells out to the locally-logged-in binary. */}
              <div className="flex flex-col gap-3">
                {LLM_PROVIDERS.map((p) => {
                  const cliKey = p.cli?.cliKey
                  const cliEnabled = cliKey ? Boolean(get(cliKey)) : false
                  return (
                    <Field key={p.id}>
                      <FieldLabel>
                        <span className="inline-flex items-center justify-between gap-2 w-full">
                          <span>{p.label}</span>
                          <a
                            href={p.url} target="_blank" rel="noopener noreferrer"
                            className="text-micro text-status-running hover:underline inline-flex items-center gap-1"
                            title={`Open ${p.consoleName} in a new tab`}
                          >
                            <ExternalLink className="h-3 w-3" /> {p.consoleName}
                          </a>
                        </span>
                      </FieldLabel>

                      {p.cli && cliKey && (
                        <CliAuthPanel
                          provider={p.id as "openai" | "anthropic_cli"}
                          cliBin={p.cli.bin}
                          loginLabel={p.cli.loginLabel ?? `Sign in with ${p.cli.bin}`}
                          enabled={cliEnabled}
                          onToggle={(v) => set(cliKey, v as never)}
                        />
                      )}

                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          {cliEnabled ? (
                            <div className="rounded-md border border-status-completed/30 bg-status-completed/5 px-3 py-2 text-small text-muted-foreground">
                              API key ignored — calls go through{" "}
                              <code className="font-mono">{p.cli?.bin}</code> CLI.
                            </div>
                          ) : (
                            <SecretInput
                              value={(get(`llm_api_key_${p.id}` as keyof SettingsValues) as string) ?? ""}
                              onChange={(v) => set(`llm_api_key_${p.id}` as keyof SettingsValues, v as never)}
                              placeholder={p.prefix}
                            />
                          )}
                        </div>
                        <LlmKeyTestButton
                          provider={p.id}
                          keyValue={(get(`llm_api_key_${p.id}` as keyof SettingsValues) as string) ?? ""}
                          cliMode={cliEnabled}
                          cliBin={p.cli?.bin}
                        />
                      </div>
                    </Field>
                  )
                })}
              </div>

              {/* Claude Code CLI — separate shape, no API key. Active when the
                  provider above is "anthropic_cli". Routes step 9 through the
                  locally-installed `claude` binary using the operator's
                  Claude Pro/Max subscription. Headless install path:
                    1. npm install -g @anthropic-ai/claude-code
                    2. `claude setup-token` (or set CLAUDE_CODE_OAUTH_TOKEN)
                  Both are driven by the Install / Sign-in buttons below. */}
              <Field>
                <FieldLabel>
                  <span className="inline-flex items-center justify-between gap-2 w-full">
                    <span className="inline-flex items-center gap-1.5">
                      Claude Code CLI
                      <span className="rounded bg-status-completed/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-completed">
                        free w/ Pro/Max
                      </span>
                    </span>
                    <a
                      href="https://docs.claude.com/en/docs/claude-code/quickstart"
                      target="_blank" rel="noopener noreferrer"
                      className="text-micro text-status-running hover:underline inline-flex items-center gap-1"
                      title="Open the Claude Code install + auth docs in a new tab"
                    >
                      <ExternalLink className="h-3 w-3" /> Claude Code docs
                    </a>
                  </span>
                </FieldLabel>
                <CliAuthPanel
                  provider="anthropic_cli"
                  cliBin="claude"
                  loginLabel="Sign in with Claude"
                  enabled={true}
                  onToggle={() => { /* anthropic_cli is CLI-only — no toggle */ }}
                  hideEnableToggle={true}
                />
                {/* Token fallback for headless servers — `claude setup-token`
                    needs a browser round-trip, which doesn't work over SSH.
                    Generate the token on a desktop and paste it here. The
                    spawn passes it via CLAUDE_CODE_OAUTH_TOKEN so the binary
                    auths without the creds file. */}
                <div className="mt-2">
                  <FieldLabel className="text-micro">
                    OAuth token <span className="text-muted-foreground">(optional — headless-server fallback)</span>
                  </FieldLabel>
                  <SecretInput
                    value={(get("claude_code_oauth_token") as string) ?? ""}
                    onChange={(v) => set("claude_code_oauth_token", v as never)}
                    placeholder="sk-ant-oat01-… (from `claude setup-token` on a desktop)"
                  />
                  <FieldDescription className="mt-1">
                    Skip <code className="font-mono">claude setup-token</code> on the server entirely:
                    run it on a desktop browser to generate the token, then paste it here.
                    Stored encrypted (Fernet) and passed to <code className="font-mono">claude</code>{" "}
                    via <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> env on every spawn.
                  </FieldDescription>
                </div>
                <FieldDescription>
                  Set the provider dropdown above to <strong>Claude Code CLI</strong> to
                  route every step-9 LLM call through the local <code className="font-mono">claude</code> binary.
                  No API key, no per-call billing — runs against your Claude
                  Pro/Max subscription. On the production server, after Install +
                  Sign in (or token paste above), every new domain pipeline AND
                  Regenerate flow will use this CLI for content generation.
                </FieldDescription>
              </Field>

              {/* Cloudflare Workers AI — separate shape (account ID + token), runs
                  Kimi K2.6 on CF's free 10k-neurons/day tier. Selected by setting
                  the active provider above to "cloudflare". */}
              <Field>
                <FieldLabel>
                  <span className="inline-flex items-center justify-between gap-2 w-full">
                    <span className="inline-flex items-center gap-1.5">
                      Cloudflare Workers AI
                      <span className="rounded bg-status-completed/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-completed">
                        free tier · K2.6
                      </span>
                    </span>
                    <a
                      href="https://dash.cloudflare.com/profile/api-tokens"
                      target="_blank" rel="noopener noreferrer"
                      className="text-micro text-status-running hover:underline inline-flex items-center gap-1"
                      title="Create a Workers AI scoped token in the Cloudflare dashboard"
                    >
                      <ExternalLink className="h-3 w-3" /> Cloudflare API Tokens
                    </a>
                  </span>
                </FieldLabel>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    value={get("cloudflare_account_id") ?? ""}
                    onChange={(e) => set("cloudflare_account_id", e.target.value)}
                    placeholder="account ID (32-char hex)"
                    className="font-mono text-small"
                  />
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <SecretInput
                        value={get("cloudflare_workers_ai_token") ?? ""}
                        onChange={(v) => set("cloudflare_workers_ai_token", v)}
                        placeholder="Workers AI API token"
                      />
                    </div>
                    <LlmKeyTestButton
                      provider="cloudflare"
                      keyValue={get("cloudflare_workers_ai_token") ?? ""}
                      extraFields={{
                        cloudflare_account_id: (get("cloudflare_account_id") ?? "").trim(),
                      }}
                    />
                  </div>
                </div>
                <FieldDescription>
                  Free plan = 10 000 neurons/day ≈ 2–5M Kimi K2.6 tokens. Token needs the
                  <code className="font-mono mx-1">Workers AI</code>read scope. Default model is{" "}
                  <code className="font-mono">@cf/moonshotai/kimi-k2.6</code>; override in the Model field above.
                  For multi-account quota stacking, use the pool below and set Active provider to{" "}
                  <code className="font-mono">cloudflare_pool</code>.
                </FieldDescription>
              </Field>

              {/* Multi-account Cloudflare Workers AI pool — round-robins K2.6 calls
                  across N accounts so the free 10k-neuron/day tier stacks N×.
                  Each row holds its own (account_id, token); rotation is LRU. */}
              <CfAiPoolCard />

              {/* Master prompt editor — the system prompt sent to the LLM at
                  step 9. Stored in DB (llm_master_prompt) so edits take
                  effect on the next generation, no restart needed. Includes
                  Google Ads compliance baseline (Privacy / Terms / Contact /
                  Disclaimer). */}
              <MasterPromptCard />

              {/* Legacy single-key fallback — collapsible just like Flask */}
              <details className="rounded-md border border-border/60 px-3 py-2">
                <summary className="cursor-pointer text-micro text-muted-foreground">
                  Legacy single-key fallback
                </summary>
                <div className="mt-2">
                  <SecretInput
                    value={get("llm_api_key") ?? ""}
                    onChange={(v) => set("llm_api_key", v)}
                    placeholder="(optional — only used if the per-provider key above is empty)"
                  />
                </div>
              </details>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- Cloudflare (link to dedicated page) ---------------- */}
          <SettingsSection
            id="cf" title="Cloudflare API Keys Pool" subtitle="Per-domain DNS zones"
            description="Each pooled key handles N domains before the pipeline auto-rotates to the next active key. Full pool management lives on the dedicated /cloudflare page."
            icon={Globe} tint={SECTIONS[4].tint}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>
                  <span className="inline-flex items-center gap-1.5">
                    Domains per CF key (default cap)
                    <span className="rounded bg-status-running/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-running">
                      pool rotation
                    </span>
                  </span>
                </FieldLabel>
                <Input
                  type="number" min={1} max={1000}
                  value={get("cf_domains_per_key") ?? ""}
                  onChange={(e) => set("cf_domains_per_key", e.target.value)}
                  placeholder="20"
                />
                <FieldDescription>
                  Default <code className="font-mono">max_domains</code> stamped on every CF key added
                  via Add CF Key on /cloudflare. When a key fills, the pipeline rolls to the next
                  active key with capacity. Set to <strong>1</strong> if you want every domain on its
                  own CF account / unique NS pair. Per-key overrides editable from the row's ⋯ menu.
                  Only affects NEW keys added after this change — existing keys keep their current cap.
                </FieldDescription>
              </Field>
              <a href="/cloudflare">
                <Button
                  variant="outline" size="sm" className="gap-1.5 btn-soft-info"
                  title="Open the dedicated Cloudflare page — add/edit keys, change A-records, bulk DNS upsert"
                >
                  <Globe className="h-3.5 w-3.5" /> Manage CF keys pool
                </Button>
              </a>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- Server SSH ---------------- */}
          <SettingsSection
            id="server" title="Server SSH" subtitle="Deploy access"
            description="Default root password set on every fresh DO droplet via cloud-init. Required for SSH-fallback deploy paths."
            icon={Terminal} tint={SECTIONS[5].tint}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>Root password</FieldLabel>
                <SecretInput value={get("server_root_password") ?? ""} onChange={(v) => set("server_root_password", v)} placeholder="SSH root password" />
              </Field>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- Alerts ---------------- */}
          <SettingsSection
            id="alerts" title="Alerts & Notifications" subtitle="Multi-channel alerting"
            description="Fan-out to all configured channels on server-dead / migration / DO-failover events. Each channel is independent."
            icon={Megaphone} tint={SECTIONS[6].tint}
          >
            <FieldGroup>
              <ToggleRow
                title="Master switch — enable alert fan-out"
                description="If off, NO channel fires (regardless of per-channel toggles below)."
                checked={get("notifications_enabled") ?? false}
                onChange={(v) => set("notifications_enabled", v)}
              />

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {/* Email */}
                <ChannelCard
                  title="Email (SMTP)"
                  icon={Mail} tone="coral"
                  enabled={get("email_enabled") ?? false}
                  onToggle={(v) => set("email_enabled", v)}
                >
                  <div className="grid grid-cols-12 gap-2">
                    <Field className="col-span-8">
                      <FieldLabel>SMTP host</FieldLabel>
                      <Input value={get("smtp_server") ?? ""} onChange={(e) => set("smtp_server", e.target.value)} placeholder="smtp.example.com" />
                    </Field>
                    <Field className="col-span-4">
                      <FieldLabel>Port</FieldLabel>
                      <Input type="number" value={get("smtp_port") ?? ""} onChange={(e) => set("smtp_port", e.target.value)} placeholder="587" />
                    </Field>
                    <Field className="col-span-6">
                      <FieldLabel>From / login</FieldLabel>
                      <Input value={get("smtp_email") ?? ""} onChange={(e) => set("smtp_email", e.target.value)} placeholder="alerts@example.com" />
                    </Field>
                    <Field className="col-span-6">
                      <FieldLabel>Password</FieldLabel>
                      <SecretInput value={get("smtp_password") ?? ""} onChange={(v) => set("smtp_password", v)} />
                    </Field>
                    <Field className="col-span-12">
                      <FieldLabel>Send alerts to</FieldLabel>
                      <Input type="email" value={get("notify_email") ?? ""} onChange={(e) => set("notify_email", e.target.value)} placeholder="you@example.com" />
                    </Field>
                  </div>
                  <NotifyTestButton channel="email" />
                </ChannelCard>

                {/* Telegram */}
                <ChannelCard
                  title="Telegram Bot"
                  icon={Send} tone="info"
                  enabled={get("telegram_enabled") ?? false}
                  onToggle={(v) => set("telegram_enabled", v)}
                >
                  <Field>
                    <FieldLabel>Bot token</FieldLabel>
                    <SecretInput value={get("telegram_bot_token") ?? ""} onChange={(v) => set("telegram_bot_token", v)} placeholder="123456:ABC-DEF…" />
                  </Field>
                  <Field>
                    <FieldLabel>Chat ID</FieldLabel>
                    <div className="flex gap-2 items-start">
                      <Input
                        value={get("telegram_chat_id") ?? ""}
                        onChange={(e) => set("telegram_chat_id", e.target.value)}
                        className="flex-1 font-mono text-small"
                        placeholder="987654321 or -100…"
                      />
                      <TelegramDetectButton
                        token={get("telegram_bot_token") ?? ""}
                        onPick={(id) => set("telegram_chat_id", String(id))}
                      />
                    </div>
                  </Field>
                  <FieldDescription>
                    1. <code className="font-mono">@BotFather</code> → <code className="font-mono">/newbot</code> → copy token.
                    {" "}2. Open your bot in Telegram and send any message.
                    {" "}3. Paste token above → click <strong>Detect</strong> → pick your chat.
                  </FieldDescription>
                  <NotifyTestButton channel="telegram" />
                </ChannelCard>

                {/* WhatsApp */}
                <ChannelCard
                  title="WhatsApp"
                  icon={MessageCircle} tone="success"
                  enabled={get("whatsapp_enabled") ?? false}
                  onToggle={(v) => set("whatsapp_enabled", v)}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <Field>
                      <FieldLabel>Provider</FieldLabel>
                      <Select value={get("whatsapp_provider") || "callmebot"} onValueChange={(v) => set("whatsapp_provider", v)}>
                        <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="callmebot">CallMeBot (free · slow)</SelectItem>
                          <SelectItem value="greenapi">Green-API (free tier · reliable)</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Recipient phone (no +)</FieldLabel>
                      <Input value={get("whatsapp_phone") ?? ""} onChange={(e) => set("whatsapp_phone", e.target.value)} placeholder="15551234567" />
                    </Field>
                  </div>
                  {(get("whatsapp_provider") || "callmebot") === "callmebot" ? (
                    <Field>
                      <FieldLabel>CallMeBot API key</FieldLabel>
                      <SecretInput value={get("whatsapp_apikey") ?? ""} onChange={(v) => set("whatsapp_apikey", v)} />
                      <FieldDescription>
                        One-time pairing: from your phone, message{" "}
                        <code className="font-mono">+34 644 99 26 98</code> with{" "}
                        <code className="font-mono">I allow callmebot to send me messages</code>.
                        Reply can take up to 2 hours.
                      </FieldDescription>
                    </Field>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Field>
                        <FieldLabel>Instance ID (idInstance)</FieldLabel>
                        <Input value={get("greenapi_instance_id") ?? ""} onChange={(e) => set("greenapi_instance_id", e.target.value)} placeholder="1101000001" />
                      </Field>
                      <Field>
                        <FieldLabel>API token (apiTokenInstance)</FieldLabel>
                        <SecretInput value={get("greenapi_api_token") ?? ""} onChange={(v) => set("greenapi_api_token", v)} />
                      </Field>
                      <Field>
                        <FieldLabel>API host (optional)</FieldLabel>
                        <Input value={get("greenapi_host") ?? ""} onChange={(e) => set("greenapi_host", e.target.value)} placeholder="auto-detect" className="font-mono text-small" />
                        <FieldDescription>
                          Leave blank for auto-detect. If Green-API shows a region-specific host like{" "}
                          <code className="font-mono">https://7105.api.greenapi.com</code> for your instance, paste it here.
                        </FieldDescription>
                      </Field>
                      <FieldDescription>
                        Setup: create a free account at <code className="font-mono">green-api.com</code>, create an
                        Instance, scan the QR with your WhatsApp (the one hosting the sender, NOT the recipient),
                        then copy idInstance + apiTokenInstance. Free tier = 200 messages/day — plenty for alerts.
                      </FieldDescription>
                    </div>
                  )}
                  <NotifyTestButton channel="whatsapp" />
                </ChannelCard>

                {/* SMS / Twilio */}
                <ChannelCard
                  title="SMS (Twilio)"
                  icon={Phone} tone="terminal"
                  enabled={get("sms_enabled") ?? false}
                  onToggle={(v) => set("sms_enabled", v)}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <Field>
                      <FieldLabel>Account SID</FieldLabel>
                      <SecretInput value={get("twilio_account_sid") ?? ""} onChange={(v) => set("twilio_account_sid", v)} />
                    </Field>
                    <Field>
                      <FieldLabel>Auth token</FieldLabel>
                      <SecretInput value={get("twilio_auth_token") ?? ""} onChange={(v) => set("twilio_auth_token", v)} />
                    </Field>
                    <Field>
                      <FieldLabel>Twilio FROM number</FieldLabel>
                      <Input value={get("twilio_from_number") ?? ""} onChange={(e) => set("twilio_from_number", e.target.value)} placeholder="+15551234567" />
                    </Field>
                    <Field>
                      <FieldLabel>Your phone</FieldLabel>
                      <Input value={get("sms_to_number") ?? ""} onChange={(e) => set("sms_to_number", e.target.value)} placeholder="+15551234567" />
                    </Field>
                  </div>
                  <FieldDescription>
                    ~$0.0075 per SMS. Both numbers must be in E.164 format (<code className="font-mono">+1…</code>).
                  </FieldDescription>
                  <NotifyTestButton channel="sms" />
                </ChannelCard>
              </div>

              <div className="flex items-center gap-3 border-t border-border pt-3">
                <NotifyTestAllButton />
                <span className="text-micro text-muted-foreground">
                  Fires to every channel that&apos;s enabled + has creds. Bypasses the master switch (always runs).
                </span>
              </div>
              <FieldDescription>
                <strong>Triggers:</strong> server marked dead · auto-migration start/complete/fail ·
                all DO tokens rejected · pipeline failures &amp; LLM blocks.
              </FieldDescription>
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- Migration ---------------- */}
          <SettingsSection
            id="migrate" title="Auto-Migrate Dead Servers" subtitle="Move domains when a server stops responding"
            description="Server is marked dead when ALL its domains fail HTTPS for N consecutive ticks. Dead-flip happens either way; auto-migrate only runs if the toggle is ON."
            icon={ArrowLeftRight} tint={SECTIONS[7].tint}
          >
            <FieldGroup>
              <ToggleRow
                title="Enable automatic migration when a server is detected dead"
                description="Without this, a dead-flip just flags the row — no domains move until you migrate manually from /servers."
                checked={get("auto_migrate_enabled") ?? false}
                onChange={(v) => set("auto_migrate_enabled", v)}
              />
              <ToggleRow
                title="Always provision a fresh droplet"
                description={
                  "When ON, a dead-server migration ALWAYS spins up a brand-new DO droplet and " +
                  "moves all domains to it — even if another existing server has spare capacity. " +
                  "Recommended when you want a clean failure boundary (no shared blast radius). " +
                  "Counts toward the Max droplets/hour cap below."
                }
                checked={get("migrate_always_provision_new") ?? false}
                onChange={(v) => set("migrate_always_provision_new", v)}
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field>
                  <FieldLabel>Dead threshold (ticks)</FieldLabel>
                  <Input
                    type="number" min={3} max={120}
                    value={get("dead_server_threshold_ticks") ?? ""}
                    onChange={(e) => set("dead_server_threshold_ticks", e.target.value)}
                    placeholder="10"
                  />
                </Field>
                <Field>
                  <FieldLabel>Tick interval (seconds)</FieldLabel>
                  <Input
                    type="number" min={10} max={600}
                    value={get("live_check_interval_s") ?? ""}
                    onChange={(e) => set("live_check_interval_s", e.target.value)}
                    placeholder="60"
                  />
                </Field>
                <Field>
                  <FieldLabel>
                    <span className="inline-flex items-center gap-1.5">
                      Max droplets/hour
                      <span className="rounded bg-status-terminal/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-status-terminal">
                        cost cap
                      </span>
                    </span>
                  </FieldLabel>
                  <Input
                    type="number" min={1} max={50}
                    value={get("max_droplets_per_hour") ?? ""}
                    onChange={(e) => set("max_droplets_per_hour", e.target.value)}
                    placeholder="3"
                  />
                </Field>
              </div>
              <BackfillCertsButton />
            </FieldGroup>
          </SettingsSection>

          {/* ---------------- Security ---------------- */}
          <SettingsSection
            id="security" title="Dashboard Security" subtitle="Protect access with password"
            description="Password is stored as a PBKDF2 hash — never kept in plaintext."
            icon={ShieldCheck} tint={SECTIONS[8].tint}
          >
            <FieldGroup>
              <Field>
                <FieldLabel>
                  Dashboard password{" "}
                  <span className="text-muted-foreground text-micro font-normal">
                    {settings.has_password
                      ? "(already set — leave blank to keep, type new to change)"
                      : "(not set — type a password to enable login)"}
                  </span>
                </FieldLabel>
                <SecretInput
                  value={get("dashboard_password") ?? ""}
                  onChange={(v) => set("dashboard_password", v)}
                  autoComplete="new-password"
                />
                <FieldDescription>
                  Blank input = no change. Type a single <code className="font-mono">-</code> (minus) to DISABLE auth.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </SettingsSection>

          {/* Sticky save bar */}
          <div className="sticky bottom-4 mt-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg">
            <div className="flex items-center gap-2 text-small">
              {err ? (
                <>
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-status-terminal/15">
                    <AlertCircle className="h-3 w-3 text-status-terminal" />
                  </span>
                  <span className="text-status-terminal">{err}</span>
                </>
              ) : savedAt ? (
                <>
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-status-completed/15">
                    <Check className="h-3 w-3 text-status-completed" />
                  </span>
                  <span className="text-muted-foreground">Saved at {savedAt.toLocaleTimeString()}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Edit any field, then click Save All Settings.</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {settings.has_password && <LogoutButton />}
              <Button
                size="sm" onClick={onSave} disabled={saving} className="gap-1.5 btn-success"
                title="Persist every changed field to the local SQLite settings table"
              >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Save All Settings
              </Button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}

/* ============================================================ */
/*  Sub-components                                              */
/* ============================================================ */

function SettingsSection({
  id, title, subtitle, description, icon: Icon, tint, children,
}: {
  id: string
  title: string
  subtitle?: string
  description: string
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  tint: { bg: string; text: string }
  children: React.ReactNode
}) {
  return (
    <section
      id={`settings-${id}`}
      className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] scroll-mt-32"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
            style={{
              backgroundColor: `color-mix(in oklch, ${tint.bg} 12%, transparent)`,
              color: tint.text,
            }}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>
              {subtitle && <span className="text-micro text-muted-foreground">{subtitle}</span>}
            </div>
            <p className="mt-0.5 text-small text-muted-foreground">{description}</p>
          </div>
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

function ToggleRow({
  title, description, checked, onChange,
}: {
  title: string; description?: string;
  checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-card px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {description && <p className="mt-0.5 text-micro text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} title={title} />
    </div>
  )
}

function SecretInput({
  value, onChange, placeholder, autoComplete,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoComplete?: string
}) {
  const [show, setShow] = React.useState(false)
  return (
    <InputGroup>
      <InputGroupAddon>
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-small"
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
      <InputGroupAddon align="inline-end">
        <button
          type="button"
          aria-label={show ? "Hide value" : "Show value"}
          title={show ? "Hide value" : "Show value"}
          onClick={() => setShow((s) => !s)}
          className="text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </InputGroupAddon>
    </InputGroup>
  )
}

function ChannelCard({
  title, icon: Icon, tone, enabled, onToggle, children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  tone: "coral" | "info" | "success" | "terminal"
  enabled: boolean
  onToggle: (v: boolean) => void
  children: React.ReactNode
}) {
  const TONES: Record<typeof tone, string> = {
    coral:    "border-status-terminal/20 bg-status-terminal/4",
    info:     "border-status-running/20 bg-status-running/4",
    success:  "border-status-completed/20 bg-status-completed/4",
    terminal: "border-status-terminal/25 bg-status-terminal/4",
  }
  const ICON_TONES: Record<typeof tone, string> = {
    coral:    "text-status-terminal",
    info:     "text-status-running",
    success:  "text-status-completed",
    terminal: "text-status-terminal",
  }
  return (
    <div className={cn("rounded-md border p-3 flex flex-col gap-2.5", TONES[tone])}>
      <div className="flex items-center justify-between gap-2">
        <div className={cn("text-[13px] font-semibold inline-flex items-center gap-1.5", ICON_TONES[tone])}>
          <Icon className="h-3.5 w-3.5" /> {title}
        </div>
        <Switch checked={enabled} onCheckedChange={onToggle} aria-label={`${title} enabled`} title={`Toggle ${title}`} />
      </div>
      {children}
    </div>
  )
}

/* --------------- DO test (detailed result) --------------- */

interface DoProbeResult {
  configured: boolean
  ok: boolean
  email: string
  status?: string
  droplet_limit?: number
  error: string
}

function DoTestButton({ primary, backup }: { primary: string; backup: string }) {
  const [busy, setBusy] = React.useState(false)
  const [out, setOut] = React.useState<{ primary: DoProbeResult; backup: DoProbeResult } | null>(null)
  const [errMsg, setErrMsg] = React.useState<string | null>(null)
  async function run() {
    setBusy(true); setOut(null); setErrMsg(null)
    try {
      const fd = new FormData()
      if (primary) fd.set("do_api_token", primary)
      if (backup) fd.set("do_api_token_backup", backup)
      const r = await fetch("/api/settings/test-do-keys", {
        method: "POST", body: fd, credentials: "same-origin",
      })
      const j = (await r.json()) as { primary: DoProbeResult; backup: DoProbeResult }
      setOut(j)
    } catch (e) {
      setErrMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function fmt(label: string, r: DoProbeResult) {
    if (!r.configured) return <span className="text-muted-foreground">{label}: not set</span>
    if (r.ok) {
      const lim = r.droplet_limit != null ? ` · limit ${r.droplet_limit}` : ""
      return (
        <span className="text-status-completed inline-flex items-center gap-1">
          <Check className="h-3 w-3" /> {label}: {r.email} ({r.status}){lim}
        </span>
      )
    }
    return (
      <span className="text-status-terminal inline-flex items-center gap-1">
        <AlertCircle className="h-3 w-3" /> {label}: {(r.error || "rejected").slice(0, 80)}
      </span>
    )
  }
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <Button
        type="button" variant="outline" size="sm" onClick={run} disabled={busy}
        className="gap-1.5 btn-soft-info"
        title="Probe both DO tokens against /v2/account — no Save needed (uses current field values)"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
        Test both tokens
      </Button>
      <div className="text-micro flex flex-col gap-0.5 flex-1 min-w-[200px]">
        {errMsg && <span className="text-status-terminal">{errMsg}</span>}
        {!errMsg && busy && (
          <span className="text-muted-foreground">
            Testing (using the values currently in the fields — no Save needed)…
          </span>
        )}
        {out && (
          <>
            <div>{fmt("primary", out.primary)}</div>
            <div>{fmt("backup", out.backup)}</div>
          </>
        )}
      </div>
    </div>
  )
}

/* --------------- LLM per-provider test --------------- */

function LlmKeyTestButton({
  provider, keyValue, cliMode = false, cliBin, extraFields,
}: {
  provider: ProviderInfo["id"] | "cloudflare"
  keyValue: string
  cliMode?: boolean
  cliBin?: string
  /** Extra form fields to include in the POST — used by the Cloudflare card
   *  to send `cloudflare_account_id` alongside the token. */
  extraFields?: Record<string, string>
}) {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{ ok: boolean; msg: string } | null>(null)
  async function run() {
    if (!cliMode && !keyValue.trim()) {
      setResult({ ok: false, msg: "Paste a key above first" }); return
    }
    setBusy(true); setResult(null)
    try {
      const fd = new FormData()
      fd.set("provider", provider)
      if (cliMode) {
        fd.set("mode", "cli")
      } else {
        fd.set("llm_api_key", keyValue.trim())
      }
      if (extraFields) {
        for (const [k, v] of Object.entries(extraFields)) fd.set(k, v)
      }
      const r = await fetch("/api/settings/test-llm-key", {
        method: "POST", body: fd, credentials: "same-origin",
      })
      const j = (await r.json()) as {
        ok?: boolean; usage?: { input_tokens?: number; output_tokens?: number }
        info?: string; label?: string; error?: string
      }
      if (j.ok) {
        let detail = ""
        if (j.usage) detail = `in=${j.usage.input_tokens ?? "?"}, out=${j.usage.output_tokens ?? "?"}`
        else if (j.info) detail = j.info
        else if (j.label) detail = `label=${j.label}`
        const prefix = cliMode ? `${cliBin ?? "cli"} OK` : "Valid"
        setResult({ ok: true, msg: `${prefix} · ${detail || "ok"}` })
      } else {
        setResult({ ok: false, msg: (j.error ?? "Rejected").slice(0, 140) })
      }
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1 min-w-[120px]">
      <Button
        type="button" variant="outline" size="sm" onClick={run} disabled={busy}
        className="gap-1.5 btn-soft-info"
        title={
          cliMode
            ? `Run a one-token probe through the ${cliBin ?? "cli"} binary`
            : `Validate the ${provider} API key against its provider's auth endpoint`
        }
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        Test
      </Button>
      {result && (
        <span className={cn(
          "text-micro",
          result.ok ? "text-status-completed" : "text-status-terminal",
        )}>
          {result.msg}
        </span>
      )}
    </div>
  )
}

/* --------------- LLM CLI install + sign-in panel --------------- */

interface CliStatusResp {
  provider: "gemini" | "openai"
  bin: string
  installed: boolean
  binaryPath: string | null
  loggedIn: boolean
  credsPath: string
  account: string | null
  loginInProgress: boolean
  loginStartedAt: number | null
  loginFailure: string | null
}

/**
 * Drives the install / sign-in / sign-out flow for one LLM CLI from inside
 * the dashboard so the operator never has to drop into a terminal.
 *
 * Polls /api/llm-cli/status every 2s while a login is in progress (the
 * detached child waits for the OAuth callback in the user's browser); idle
 * state polls every 12s as a cheap drift check. On loginInProgress true,
 * the user is told to complete the sign-in in the browser tab the CLI just
 * opened; on success the credentials file appears, the panel flips to
 * "Signed in", and the parent toggle becomes flippable.
 */
function CliAuthPanel({
  provider, cliBin, loginLabel, enabled, onToggle, hideEnableToggle = false,
}: {
  provider: "openai" | "anthropic_cli"
  cliBin: string
  loginLabel: string
  /** Whether the CLI mode is currently active. For *_cli providers
   *  this is always true (selecting the provider IS the toggle), so the
   *  card hides the on/off switch — pass `enabled=true onToggle={()=>{}}`
   *  AND `hideEnableToggle={true}`. */
  enabled: boolean
  onToggle: (v: boolean) => void
  /** When true, the "use this CLI" toggle is hidden from the signed-in
   *  state (only Sign-out remains). For providers where selection is
   *  driven by the provider dropdown, not a per-row toggle. */
  hideEnableToggle?: boolean
}) {
  const [status, setStatus] = React.useState<CliStatusResp | null>(null)
  const [busy, setBusy] = React.useState<"install" | "login" | "signout" | "cancel" | null>(null)
  const [actionMsg, setActionMsg] = React.useState<string | null>(null)
  const pollTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const r = await fetch(`/api/llm-cli/status?provider=${provider}`, { credentials: "same-origin" })
      if (!r.ok) return
      const j = (await r.json()) as CliStatusResp
      setStatus(j)
    } catch { /* leave previous status */ }
  }, [provider])

  React.useEffect(() => {
    refresh()
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current) }
  }, [refresh])

  // Adaptive polling: tight while the OAuth flow is in flight (the user is
  // mid-login and we want the panel to flip to "Signed in" the instant the
  // creds file appears), slow otherwise so an idle settings page doesn't
  // hammer the route every couple of seconds.
  React.useEffect(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    const delay = status?.loginInProgress ? 2000 : 12_000
    pollTimer.current = setTimeout(refresh, delay)
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current) }
  }, [status, refresh])

  // When login flips from in-progress to signed-in, auto-enable the toggle
  // so the user doesn't have to hunt for it. Only does this on the actual
  // transition; doesn't re-enable if the user explicitly turned it off.
  const wasInProgress = React.useRef(false)
  React.useEffect(() => {
    if (!status) return
    if (wasInProgress.current && status.loggedIn && !enabled) {
      onToggle(true)
    }
    wasInProgress.current = status.loginInProgress
  }, [status, enabled, onToggle])

  async function postJson(path: string, body: object): Promise<{ ok: boolean; error?: string }> {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    })
    return (await r.json()) as { ok: boolean; error?: string }
  }

  async function onInstall() {
    setBusy("install"); setActionMsg("Installing — this can take 10-30s on a cold npm cache.")
    try {
      const r = await postJson("/api/llm-cli/install", { provider })
      setActionMsg(r.ok ? "Installed." : `Install failed: ${r.error ?? "unknown"}`)
      await refresh()
    } catch (e) {
      setActionMsg(`Install failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function onLogin() {
    setBusy("login"); setActionMsg("Opening your browser — complete the sign-in there.")
    try {
      const r = await postJson("/api/llm-cli/login", { provider })
      if (!r.ok) {
        setActionMsg(`Sign-in could not start: ${r.error ?? "unknown"}`)
      }
      await refresh()
    } catch (e) {
      setActionMsg(`Sign-in failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  async function onCancel() {
    setBusy("cancel"); setActionMsg(null)
    try {
      await fetch(`/api/llm-cli/login?provider=${provider}`, {
        method: "DELETE", credentials: "same-origin",
      })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function onSignOut() {
    if (!confirm(
      `Sign out of ${cliBin}? The credentials file will be deleted; ` +
      `you'll need to sign in again before generation calls work.`,
    )) return
    setBusy("signout"); setActionMsg(null)
    try {
      const r = await postJson("/api/llm-cli/signout", { provider })
      setActionMsg(r.ok ? "Signed out." : `Sign-out failed: ${r.error ?? "unknown"}`)
      if (r.ok && enabled) onToggle(false)  // CLI mode is meaningless without creds
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  // ----- Render -----

  if (!status) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2 mb-2 text-micro text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking <code className="font-mono">{cliBin}</code> install + sign-in state…
        </span>
      </div>
    )
  }

  // Three primary states drive the right-hand action area:
  //   1. Not installed → Install button
  //   2. Installed, not signed in → Sign in (or Cancel, while in progress)
  //   3. Signed in → toggle + Sign out
  let stateBadge: React.ReactNode
  let action: React.ReactNode

  if (!status.installed) {
    stateBadge = <span className="text-status-terminal">Not installed</span>
    action = (
      <Button
        size="sm" variant="outline" onClick={onInstall} disabled={busy !== null}
        className="gap-1.5 btn-soft-info"
        title={`npm install -g the ${cliBin} CLI globally`}
      >
        {busy === "install" ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
        Install <code className="font-mono">{cliBin}</code>
      </Button>
    )
  } else if (status.loginInProgress) {
    stateBadge = (
      <span className="inline-flex items-center gap-1.5 text-status-running">
        <Loader2 className="h-3 w-3 animate-spin" />
        Waiting for browser sign-in…
      </span>
    )
    action = (
      <Button
        size="sm" variant="outline" onClick={onCancel} disabled={busy !== null}
        className="gap-1.5"
        title="Kill the background CLI process and reset the panel"
      >
        Cancel
      </Button>
    )
  } else if (!status.loggedIn) {
    stateBadge = <span className="text-status-waiting">Installed, not signed in</span>
    action = (
      <Button
        size="sm" variant="outline" onClick={onLogin} disabled={busy !== null}
        className="gap-1.5 btn-soft-info"
        title={`Open the OAuth flow in your default browser`}
      >
        {busy === "login" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
        {loginLabel}
      </Button>
    )
  } else {
    stateBadge = (
      <span className="inline-flex items-center gap-1.5 text-status-completed">
        <Check className="h-3 w-3" />
        Signed in{status.account ? ` as ${status.account}` : ""}
      </span>
    )
    action = (
      <div className="flex items-center gap-2">
        {!hideEnableToggle && (
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            aria-label={`Use ${cliBin} CLI auth`}
            title={`Toggle CLI auth via ${cliBin}`}
          />
        )}
        <Button
          size="sm" variant="ghost" onClick={onSignOut} disabled={busy !== null}
          className="gap-1.5 text-muted-foreground hover:text-status-terminal"
          title="Delete the cached credentials file"
        >
          {busy === "signout" ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
          Sign out
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 mb-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-medium inline-flex items-center gap-1.5">
            <Terminal className="h-3 w-3" />
            Local CLI auth (<code className="font-mono">{cliBin}</code>)
            <span className="text-muted-foreground font-normal">·</span>
            <span className="text-micro font-normal">{stateBadge}</span>
          </div>
          <p className="mt-0.5 text-micro text-muted-foreground">
            Skip the API key and let the dashboard call your locally-installed{" "}
            <code className="font-mono">{cliBin}</code> binary. Uses your free / consumer tier — no separate API billing.
          </p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>

      {(actionMsg || status.loginFailure) && (
        <p
          className={cn(
            "mt-2 text-micro",
            status.loginFailure ? "text-status-terminal" : "text-muted-foreground",
          )}
        >
          {status.loginFailure ?? actionMsg}
        </p>
      )}
    </div>
  )
}

/* --------------- Per-channel notify test --------------- */

function NotifyTestButton({ channel }: { channel: "email" | "telegram" | "whatsapp" | "sms" }) {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{ ok: boolean; msg: string } | null>(null)
  async function run() {
    setBusy(true); setResult(null)
    try {
      const fd = new FormData()
      fd.set("channel", channel)
      const r = await fetch("/api/settings/test-notification", {
        method: "POST", body: fd, credentials: "same-origin",
      })
      const j = (await r.json()) as {
        ok?: boolean
        result?: { results?: Record<string, [boolean, string]> }
        error?: string
      }
      if (!j.ok) {
        setResult({ ok: false, msg: j.error ?? "error" }); return
      }
      const r2 = (j.result?.results ?? {})[channel] ?? [false, "no result"]
      setResult({ ok: r2[0], msg: String(r2[1]).slice(0, 120) })
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button
        type="button" variant="outline" size="sm" onClick={run} disabled={busy}
        className="gap-1.5"
        title={`Fire a one-off test alert through ${channel} (bypasses the master switch)`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        Send test {channel}
      </Button>
      {result && (
        <span className={cn(
          "text-micro inline-flex items-center gap-1",
          result.ok ? "text-status-completed" : "text-status-terminal",
        )}>
          {result.ok ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
          {result.msg}
        </span>
      )}
    </div>
  )
}

/* --------------- Test ALL channels at once --------------- */

function NotifyTestAllButton() {
  const [busy, setBusy] = React.useState(false)
  const [out, setOut] = React.useState<{ rows: [string, boolean, string][]; empty: boolean } | null>(null)
  async function run() {
    setBusy(true); setOut(null)
    try {
      const fd = new FormData()
      fd.set("channel", "all")
      const r = await fetch("/api/settings/test-notification", {
        method: "POST", body: fd, credentials: "same-origin",
      })
      const j = (await r.json()) as {
        ok?: boolean
        result?: {
          channels?: string[]
          results?: Record<string, [boolean, string]>
        }
        error?: string
      }
      if (!j.ok) { setOut({ rows: [["error", false, j.error ?? "error"]], empty: false }); return }
      const channels = j.result?.channels ?? []
      const rows: [string, boolean, string][] = Object.entries(j.result?.results ?? {})
        .map(([k, v]) => [k, v[0], String(v[1]).slice(0, 100)])
      setOut({ rows, empty: channels.length === 0 })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button" size="sm" onClick={run} disabled={busy}
        className="gap-1.5 btn-info"
        title="Fire a test alert through every channel that's enabled + has creds — bypasses the master switch"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
        Test ALL channels at once
      </Button>
      {out && (
        <div className="text-micro flex flex-col gap-0.5">
          {out.empty && (
            <span className="text-status-waiting inline-flex items-center gap-1">
              <AlertCircle className="h-3 w-3" /> No channels enabled — flip a switch first.
            </span>
          )}
          {out.rows.map(([k, ok, msg]) => (
            <span key={k} className={ok ? "text-status-completed" : "text-status-terminal"}>
              {ok ? "✓" : "✗"} {k}: {msg}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* --------------- Telegram chat-ID detector --------------- */

function TelegramDetectButton({
  token, onPick,
}: {
  token: string
  onPick: (id: number) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [chats, setChats] = React.useState<Array<{
    id: number; type: string; title?: string; username?: string;
    first_name?: string; last_name?: string
  }> | null>(null)
  const [bot, setBot] = React.useState<{ username?: string; name?: string } | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  async function run() {
    if (!token.trim()) { setErr("Paste the bot token first."); return }
    setBusy(true); setErr(null); setChats(null); setBot(null)
    try {
      const fd = new FormData()
      fd.set("telegram_bot_token", token.trim())
      const r = await fetch("/api/settings/telegram-detect-chat", {
        method: "POST", body: fd, credentials: "same-origin",
      })
      const j = (await r.json()) as {
        ok?: boolean
        bot?: { username?: string; name?: string }
        chats?: typeof chats
        error?: string
        hint?: string
      }
      if (!j.ok) { setErr(j.error ?? "failed"); return }
      setBot(j.bot ?? null)
      setChats(j.chats ?? [])
      if ((j.chats ?? []).length === 0) {
        setErr(j.hint ?? "No chats yet. Open your bot in Telegram and send it any message, then click Detect again.")
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button" variant="outline" size="sm" onClick={run} disabled={busy}
        className="gap-1.5 self-start"
        title="Call getUpdates via the bot token to list chats that have messaged the bot"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        Detect chat ID
      </Button>
      {bot?.username && (
        <span className="text-micro text-muted-foreground">
          Bot: <code className="font-mono">@{bot.username}</code>
          {bot.name ? ` (${bot.name})` : ""}
        </span>
      )}
      {err && <span className="text-micro text-status-waiting">{err}</span>}
      {chats && chats.length > 0 && (
        <>
          <span className="text-micro text-muted-foreground">Click a chat to auto-fill:</span>
          <div className="flex flex-col gap-1">
            {chats.map((c) => {
              const label = c.type === "private"
                ? `${c.first_name ?? ""}${c.last_name ? " " + c.last_name : ""}${c.username ? ` (@${c.username})` : ""} — private DM`
                : `${c.title || c.username || "?"} — ${c.type}`
              return (
                <button
                  key={c.id} type="button"
                  className="text-left text-micro rounded border border-border/60 px-2 py-1 hover:bg-muted font-mono"
                  onClick={() => onPick(c.id)}
                  title="Click to fill the Chat ID field above"
                >
                  {c.id} · <span className="font-sans">{label}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/* --------------- Logout --------------- */

function LogoutButton() {
  const [busy, setBusy] = React.useState(false)
  async function run() {
    if (!confirm("Sign out of the dashboard?")) return
    setBusy(true)
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" })
    } catch {
      /* swallow — cookie may already be cleared */
    } finally {
      window.location.assign("/login")
    }
  }
  return (
    <Button
      type="button" variant="outline" size="sm" onClick={run} disabled={busy}
      className="gap-1.5 btn-soft-destructive"
      title="Sign out — clears the iron-session cookie"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
      Logout
    </Button>
  )
}

/* --------------- Backfill Origin certs --------------- */

function BackfillCertsButton() {
  const [busy, setBusy] = React.useState(false)
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null)
  async function run() {
    if (!confirm(
      "Re-issue Origin SSL certs for every domain missing a cached copy?\n\n" +
      "Calls Cloudflare once per domain (~1s each). Safe — the existing cert on the server keeps working."
    )) return
    setBusy(true); setMsg(null)
    const r = await domainActions.backfillOriginCerts()
    setMsg({ kind: r.ok ? "ok" : "err", text: r.message ?? r.error ?? "" })
    setBusy(false)
  }
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      <div>
        <Button
          type="button" variant="outline" size="sm" onClick={run} disabled={busy}
          className="gap-1.5 btn-soft-info"
          title="Caches CF Origin CA certs in DB so future migrations skip the ~30s re-issue step"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldPlus className="h-3.5 w-3.5" />}
          Backfill Origin certs for pre-Phase-1 domains
        </Button>
      </div>
      <span className="text-micro text-muted-foreground">
        Caches CF Origin CA certs in DB so future migrations can skip the ~30s re-issue step.
      </span>
      {msg && (
        <span className={cn(
          "text-micro",
          msg.kind === "ok" ? "text-status-completed" : "text-status-terminal",
        )}>
          {msg.text}
        </span>
      )}
    </div>
  )
}
