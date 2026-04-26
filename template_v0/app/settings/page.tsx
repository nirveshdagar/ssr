"use client"

import * as React from "react"
import {
  Server as ServerIcon,
  Cloud,
  Rocket,
  Bell,
  Sparkles,
  ShieldCheck,
  Globe,
  Database,
  KeyRound,
  Eye,
  EyeOff,
  Check,
} from "lucide-react"
import { AppShell } from "@/components/ssr/app-shell"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSet, FieldLegend } from "@/components/ui/field"
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

const SECTIONS = [
  { id: "do",        label: "DigitalOcean", icon: Rocket },
  { id: "sa",        label: "ServerAvatar", icon: ServerIcon },
  { id: "spaceship", label: "Spaceship",    icon: Globe },
  { id: "cf",        label: "Cloudflare",   icon: Cloud },
  { id: "llm",       label: "LLM",          icon: Sparkles },
  { id: "alerts",    label: "Alerts",       icon: Bell },
  { id: "security",  label: "Security",     icon: ShieldCheck },
  { id: "storage",   label: "Storage",      icon: Database },
]

export default function SettingsPage() {
  const [active, setActive] = React.useState("do")

  return (
    <AppShell
      title="Settings"
      description="Credentials, integrations, and operator preferences"
      breadcrumbs={[{ label: "Settings" }]}
      accent="settings"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        {/* Section nav */}
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
                    >
                      <Icon className={cn("h-3.5 w-3.5", isActive ? "text-primary" : "text-muted-foreground")} />
                      {s.label}
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
        </aside>

        {/* Sections */}
        <div className="flex flex-col gap-4">
          <SettingsSection
            id="do"
            title="DigitalOcean"
            description="API tokens, default droplet size, and region preferences."
            icon={Rocket}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="do-token">API token</FieldLabel>
                <SecretInput id="do-token" defaultValue="dop_v1_••••••••••••••••••••••••••••••••" />
                <FieldDescription>Read+write scope. Rotate every 90 days.</FieldDescription>
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="do-region">Default region</FieldLabel>
                  <Select defaultValue="nyc3">
                    <SelectTrigger id="do-region" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="nyc3">NYC3 — New York</SelectItem>
                      <SelectItem value="sfo3">SFO3 — San Francisco</SelectItem>
                      <SelectItem value="ams3">AMS3 — Amsterdam</SelectItem>
                      <SelectItem value="fra1">FRA1 — Frankfurt</SelectItem>
                      <SelectItem value="sgp1">SGP1 — Singapore</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="do-size">Default size</FieldLabel>
                  <Select defaultValue="s-1vcpu-1gb">
                    <SelectTrigger id="do-size" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="s-1vcpu-1gb">s-1vcpu-1gb · $6/mo</SelectItem>
                      <SelectItem value="s-1vcpu-2gb">s-1vcpu-2gb · $12/mo</SelectItem>
                      <SelectItem value="s-2vcpu-2gb">s-2vcpu-2gb · $18/mo</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <ToggleRow
                title="Auto-create droplet on pipeline run"
                description="When no server has capacity, provision a new droplet automatically."
                defaultChecked
              />
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="sa"
            title="ServerAvatar"
            description="Agent installation token and SSH options."
            icon={ServerIcon}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sa-token">Install token</FieldLabel>
                <SecretInput id="sa-token" defaultValue="sa_••••••••••••••••" />
              </Field>
              <Field>
                <FieldLabel htmlFor="sa-key">Default SSH key fingerprint</FieldLabel>
                <Input id="sa-key" defaultValue="SHA256:Pq4Hc…3mZ" className="h-8 font-mono text-small" />
              </Field>
              <ToggleRow title="Auto-issue Let's Encrypt cert" description="Run certbot at step 7." defaultChecked />
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="spaceship"
            title="Spaceship"
            description="Registrar credentials and acquisition rules."
            icon={Globe}
          >
            <FieldGroup>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="ss-key">API key</FieldLabel>
                  <SecretInput id="ss-key" defaultValue="ss_•••••••••••••" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="ss-secret">API secret</FieldLabel>
                  <SecretInput id="ss-secret" defaultValue="••••••••••••••••" />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="ss-tlds">Allowed TLDs</FieldLabel>
                <Input
                  id="ss-tlds"
                  defaultValue=".com .io .dev .app .co .net .org"
                  className="h-8 font-mono text-small"
                />
                <FieldDescription>Space-separated list. Pipeline rejects others.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="ss-budget">Max price per domain (USD)</FieldLabel>
                <Input id="ss-budget" type="number" defaultValue={14} className="h-8 w-32 text-small" />
              </Field>
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="cf"
            title="Cloudflare"
            description="Pool behavior, default DNS settings, and rate-limit thresholds."
            icon={Cloud}
          >
            <FieldGroup>
              <ToggleRow
                title="Auto-rotate exhausted keys"
                description="Move new domains to the next healthy pool key when one hits 90%."
                defaultChecked
              />
              <ToggleRow
                title="Always Use HTTPS"
                description="Set on every new zone."
                defaultChecked
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="cf-ssl">Default SSL mode</FieldLabel>
                  <Select defaultValue="strict">
                    <SelectTrigger id="cf-ssl" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="flexible">Flexible</SelectItem>
                      <SelectItem value="full">Full</SelectItem>
                      <SelectItem value="strict">Full (strict)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="cf-warn">Rate-limit warning threshold</FieldLabel>
                  <Input id="cf-warn" type="number" defaultValue={70} className="h-8 w-24 text-small" />
                </Field>
              </div>
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="llm"
            title="LLM site generation"
            description="Provider, model, and prompt template for single-page PHP sites."
            icon={Sparkles}
          >
            <FieldGroup>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="llm-provider">Provider</FieldLabel>
                  <Select defaultValue="anthropic">
                    <SelectTrigger id="llm-provider" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="gateway">Vercel AI Gateway</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="llm-model">Model</FieldLabel>
                  <Select defaultValue="claude-opus-4.6">
                    <SelectTrigger id="llm-model" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude-opus-4.6">claude-opus-4.6</SelectItem>
                      <SelectItem value="gpt-5-mini">gpt-5-mini</SelectItem>
                      <SelectItem value="gemini-3-flash">gemini-3-flash</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="llm-key">API key</FieldLabel>
                <SecretInput id="llm-key" defaultValue="sk-ant-•••••••••••••••" />
              </Field>
              <Field>
                <FieldLabel htmlFor="llm-prompt">Prompt template</FieldLabel>
                <Textarea
                  id="llm-prompt"
                  rows={5}
                  defaultValue={`Generate a single-page PHP site for {domain}.\nKeyword theme: {theme}.\nReturn valid PHP only — no markdown.`}
                  className="font-mono text-small"
                />
              </Field>
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="alerts"
            title="Alerts"
            description="Slack and email destinations for pipeline events."
            icon={Bell}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="slack-webhook">Slack webhook URL</FieldLabel>
                <Input
                  id="slack-webhook"
                  defaultValue="https://hooks.slack.com/services/T0••••/B0••••/••••••"
                  className="h-8 font-mono text-small"
                />
              </Field>
              <FieldSet>
                <FieldLegend>Notify on</FieldLegend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <ToggleRow title="Pipeline completion" defaultChecked />
                  <ToggleRow title="Terminal errors" defaultChecked />
                  <ToggleRow title="Retry exhaustion" defaultChecked />
                  <ToggleRow title="CF key exhausted" defaultChecked />
                  <ToggleRow title="Server marked dead" defaultChecked />
                  <ToggleRow title="Daily summary" />
                </div>
              </FieldSet>
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="security"
            title="Security"
            description="Session, IP allowlist, and audit retention."
            icon={ShieldCheck}
          >
            <FieldGroup>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="session">Session lifetime</FieldLabel>
                  <Select defaultValue="8h">
                    <SelectTrigger id="session" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1h">1 hour</SelectItem>
                      <SelectItem value="8h">8 hours</SelectItem>
                      <SelectItem value="24h">24 hours</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="audit-retain">Audit retention</FieldLabel>
                  <Select defaultValue="365">
                    <SelectTrigger id="audit-retain" className="h-8 text-small">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">30 days</SelectItem>
                      <SelectItem value="90">90 days</SelectItem>
                      <SelectItem value="365">365 days</SelectItem>
                      <SelectItem value="forever">Forever</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="allowlist">IP allowlist (CIDR)</FieldLabel>
                <Textarea
                  id="allowlist"
                  rows={3}
                  defaultValue={"203.0.113.0/24\n198.51.100.42/32"}
                  className="font-mono text-small"
                />
              </Field>
              <ToggleRow
                title="Require fresh password every 24h"
                description="Forces re-auth on long sessions."
              />
            </FieldGroup>
          </SettingsSection>

          <SettingsSection
            id="storage"
            title="Storage"
            description="Generated site assets and pipeline artifact retention."
            icon={Database}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bucket">S3-compatible bucket</FieldLabel>
                <Input id="bucket" defaultValue="ssr-prod-artifacts" className="h-8 font-mono text-small" />
              </Field>
              <Field>
                <FieldLabel htmlFor="retain">Artifact retention</FieldLabel>
                <Select defaultValue="90">
                  <SelectTrigger id="retain" className="h-8 w-44 text-small">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="forever">Forever</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
          </SettingsSection>

          {/* Sticky save bar */}
          <div className="sticky bottom-4 mt-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg">
            <div className="flex items-center gap-2 text-small">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-status-completed/15">
                <Check className="h-3 w-3 text-status-completed" />
              </span>
              <span className="text-muted-foreground">All changes saved · last edited 2 min ago</span>
            </div>
            <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm">Discard</Button>
                  <Button size="sm" className="btn-success gap-1.5">Save changes</Button>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}

/* ------------------------------------------------------------------ */

function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  children,
}: {
  id: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section
      id={`settings-${id}`}
      className="rounded-md border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04)] scroll-mt-32"
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-small text-muted-foreground">{description}</p>
          </div>
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

function ToggleRow({
  title,
  description,
  defaultChecked,
}: {
  title: string
  description?: string
  defaultChecked?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-card px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {description && <p className="mt-0.5 text-micro text-muted-foreground">{description}</p>}
      </div>
      <Switch defaultChecked={defaultChecked} aria-label={title} />
    </div>
  )
}

function SecretInput({ id, defaultValue }: { id: string; defaultValue: string }) {
  const [show, setShow] = React.useState(false)
  return (
    <InputGroup>
      <InputGroupAddon>
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        id={id}
        type={show ? "text" : "password"}
        defaultValue={defaultValue}
        className="font-mono text-small"
      />
      <InputGroupAddon align="inline-end">
        <button
          type="button"
          aria-label={show ? "Hide value" : "Show value"}
          onClick={() => setShow((s) => !s)}
          className="text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </InputGroupAddon>
    </InputGroup>
  )
}
