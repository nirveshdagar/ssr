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
  id: "anthropic" | "openai" | "gemini" | "openrouter"
  label: string
  prefix: string
  url: string
  consoleName: string
  modelExample: string
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
  },
  {
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
                  <FieldLabel>Active provider</FieldLabel>
                  <Select value={get("llm_provider") || "anthropic"} onValueChange={(v) => set("llm_provider", v)}>
                    <SelectTrigger className="h-8 text-small"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                      <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                      <SelectItem value="gemini">Google Gemini</SelectItem>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>Model</FieldLabel>
                  <Input
                    value={get("llm_model") ?? ""}
                    onChange={(e) => set("llm_model", e.target.value)}
                    placeholder="auto (provider default)"
                    className="font-mono text-small"
                  />
                  <FieldDescription>
                    Examples — Anthropic: <code className="font-mono">claude-haiku-4-5-20251001</code>{" "}
                    · OpenAI: <code className="font-mono">gpt-5.4-mini</code>{" "}
                    · Gemini: <code className="font-mono">gemini-2.5-flash</code>{" "}
                    · OpenRouter: <code className="font-mono">google/gemini-2.5-flash</code>
                  </FieldDescription>
                </Field>
              </div>

              {/* Per-provider keys — each with its own Test button + console link. */}
              <div className="flex flex-col gap-3">
                {LLM_PROVIDERS.map((p) => (
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
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <SecretInput
                          value={(get(`llm_api_key_${p.id}` as keyof SettingsValues) as string) ?? ""}
                          onChange={(v) => set(`llm_api_key_${p.id}` as keyof SettingsValues, v as never)}
                          placeholder={p.prefix}
                        />
                      </div>
                      <LlmKeyTestButton
                        provider={p.id}
                        keyValue={(get(`llm_api_key_${p.id}` as keyof SettingsValues) as string) ?? ""}
                      />
                    </div>
                  </Field>
                ))}
              </div>

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
            description="Each pooled key handles ~20 domains before the pipeline auto-rotates. Full pool management lives on the dedicated /cloudflare page."
            icon={Globe} tint={SECTIONS[4].tint}
          >
            <a href="/cloudflare">
              <Button
                variant="outline" size="sm" className="gap-1.5 btn-soft-info"
                title="Open the dedicated Cloudflare page — add/edit keys, change A-records, bulk DNS upsert"
              >
                <Globe className="h-3.5 w-3.5" /> Manage CF keys pool
              </Button>
            </a>
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

function LlmKeyTestButton({ provider, keyValue }: { provider: ProviderInfo["id"]; keyValue: string }) {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{ ok: boolean; msg: string } | null>(null)
  async function run() {
    if (!keyValue.trim()) {
      setResult({ ok: false, msg: "Paste a key above first" }); return
    }
    setBusy(true); setResult(null)
    try {
      const fd = new FormData()
      fd.set("provider", provider)
      fd.set("llm_api_key", keyValue.trim())
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
        setResult({ ok: true, msg: `Valid · ${detail || "ok"}` })
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
        title={`Validate the ${provider} API key against its provider's auth endpoint`}
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
