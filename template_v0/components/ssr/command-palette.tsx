"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import {
  Globe,
  Server as ServerIcon,
  Cloud,
  Activity,
  ScrollText,
  ShieldCheck,
  Settings as SettingsIcon,
  Plus,
  Play,
  Trash2,
  RefreshCw,
  Home,
} from "lucide-react"
import { useDomains } from "@/hooks/use-domains"
import { useServers } from "@/hooks/use-servers"
import { useCfKeys } from "@/hooks/use-cf-keys"
import { domainActions } from "@/lib/api-actions"

/**
 * Global command palette. Open via ⌘K / Ctrl+K, or by dispatching a
 * `ssr:open-palette` custom event (used by the top-bar search button so
 * mouse + keyboard reach the same UI).
 *
 * Shows three resource groups (Domains, Servers, CF keys) sourced from
 * the existing SWR caches — meaning palette opens are instant after the
 * first page load — plus a Quick actions section for nav + per-domain
 * "Run pipeline" shortcuts.
 */
export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()
  const { rows: domains } = useDomains()
  const { rows: servers } = useServers()
  const { rows: cfKeys } = useCfKeys()

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === "Escape") setOpen(false)
    }
    function onCustom() { setOpen(true) }
    window.addEventListener("keydown", onKey)
    window.addEventListener("ssr:open-palette", onCustom)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("ssr:open-palette", onCustom)
    }
  }, [])

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }
  async function runPipelineFor(domain: string) {
    setOpen(false)
    if (!confirm(`Run pipeline for ${domain}?`)) return
    const r = await domainActions.runPipeline(domain)
    window.alert(r.message ?? r.error ?? "submitted")
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search domains, servers, CF keys, or run an operator action"
    >
      <CommandInput placeholder="Type to search domains, servers, CF keys, or actions…" />
      <CommandList>
        <CommandEmpty>No matches. Try a domain, IP, server name, or action.</CommandEmpty>

        <CommandGroup heading="Quick actions">
          <CommandItem onSelect={() => go("/")}>
            <Home className="text-[color:var(--page-dashboard)]" />
            <span>Open Dashboard</span>
            <CommandShortcut>g d</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => go("/domains")}>
            <Globe className="text-[color:var(--page-domains)]" />
            <span>Open Domains</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/servers")}>
            <ServerIcon className="text-[color:var(--page-servers)]" />
            <span>Open Servers</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/cloudflare")}>
            <Cloud className="text-[color:var(--page-cloudflare)]" />
            <span>Open Cloudflare</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/watcher")}>
            <Activity className="text-[color:var(--page-watcher)]" />
            <span>Open Watcher</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/logs")}>
            <ScrollText className="text-[color:var(--page-logs)]" />
            <span>Open Logs</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/audit")}>
            <ShieldCheck className="text-[color:var(--page-audit)]" />
            <span>Open Audit log</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")}>
            <SettingsIcon className="text-[color:var(--page-settings)]" />
            <span>Open Settings</span>
          </CommandItem>
        </CommandGroup>

        {domains.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Domains">
              {domains.slice(0, 30).map((d) => (
                <CommandItem
                  key={`d-${d.id}`}
                  value={`domain ${d.name} ${d.ip} ${d.status}`}
                  onSelect={() => go(`/domains/${encodeURIComponent(d.name)}`)}
                >
                  <Globe />
                  <span className="font-mono">{d.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{d.status}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {servers.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Servers">
              {servers.slice(0, 20).map((s) => (
                <CommandItem
                  key={`s-${s.id}`}
                  value={`server ${s.name} ${s.ip} ${s.region} ${s.doDropletId} ${s.saServerId}`}
                  onSelect={() => go(`/servers?focus=${encodeURIComponent(s.name)}`)}
                >
                  <ServerIcon />
                  <span className="font-mono">{s.name}</span>
                  <span className="text-xs text-muted-foreground">{s.ip}</span>
                  <span className="ml-auto text-xs text-muted-foreground uppercase">{s.region}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {cfKeys.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Cloudflare keys">
              {cfKeys.slice(0, 20).map((k) => (
                <CommandItem
                  key={`k-${k.id}`}
                  value={`cf ${k.label} ${k.email} ${k.accountId}`}
                  onSelect={() => go(`/cloudflare?key=${k.id}`)}
                >
                  <Cloud />
                  <span className="font-mono">{k.label}</span>
                  <span className="text-xs text-muted-foreground">{k.email}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {k.domains}/{k.maxDomains}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {domains.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Run pipeline">
              {domains.slice(0, 10).map((d) => (
                <CommandItem
                  key={`r-${d.id}`}
                  value={`run pipeline ${d.name}`}
                  onSelect={() => runPipelineFor(d.name)}
                >
                  <Play className="text-[color:var(--success)]" />
                  <span>
                    Run pipeline for <span className="font-mono">{d.name}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Operator actions">
          <CommandItem
            value="add new domain"
            onSelect={() => go("/domains")}
          >
            <Plus className="text-[color:var(--page-domains)]" />
            <span>Add new domain (opens Domains page)</span>
          </CommandItem>
          <CommandItem
            value="new droplet provision do"
            onSelect={() => go("/servers")}
          >
            <Plus className="text-[color:var(--page-servers)]" />
            <span>New DO droplet</span>
          </CommandItem>
          <CommandItem
            value="add cloudflare api key"
            onSelect={() => go("/cloudflare")}
          >
            <Plus className="text-[color:var(--page-cloudflare)]" />
            <span>Add Cloudflare API key</span>
          </CommandItem>
          <CommandItem
            value="check ns nameservers all"
            onSelect={async () => {
              setOpen(false)
              const r = await domainActions.checkAllNs() as { ok?: boolean; active?: number; pending?: number; errors?: number }
              window.alert(`NS check — ${r.active ?? 0} active · ${r.pending ?? 0} pending · ${r.errors ?? 0} errors`)
            }}
          >
            <RefreshCw className="text-[color:var(--info)]" />
            <span>Check NS for all domains</span>
          </CommandItem>
          <CommandItem
            value="sync from serveravatar"
            onSelect={async () => {
              setOpen(false)
              if (!confirm("Sync domains from ServerAvatar — drop dashboard rows whose SA app is gone?")) return
              const r = await domainActions.syncFromSa()
              window.alert(r.message ?? r.error ?? "submitted")
            }}
          >
            <Trash2 className="text-[color:var(--warning)]" />
            <span>Sync (clean up) from ServerAvatar</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
