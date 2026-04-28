import {
  LayoutDashboard,
  Globe,
  Server,
  Cloud,
  Activity,
  ScrollText,
  ShieldCheck,
  Settings,
  Boxes,
  type LucideIcon,
} from "lucide-react"

export type NavAccent =
  | "dashboard"
  | "domains"
  | "servers"
  | "cloudflare"
  | "watcher"
  | "logs"
  | "audit"
  | "settings"
  | "sa"

/** Keys the sidebar can pull from /api/status counts to render a live badge. */
export type NavBadgeKey = "domains" | "servers" | "cf_keys" | "active_watchers"

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  /** Static badge — only used when no live `badgeKey` is set. */
  badge?: string | number
  /** Runtime badge — sidebar resolves this against /api/status counts. */
  badgeKey?: NavBadgeKey
  accent: NavAccent
}

/**
 * Static nav metadata. Badge counts live in the AppSidebar runtime via
 * `badgeKey` — pulled from /api/status so they reflect the live DB instead
 * of compile-time placeholders. Compile-time `badge` only exists for
 * sections that don't have a meaningful count.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard, accent: "dashboard" },
  { label: "Domains", href: "/domains", icon: Globe, badgeKey: "domains", accent: "domains" },
  { label: "Servers", href: "/servers", icon: Server, badgeKey: "servers", accent: "servers" },
  { label: "ServerAvatar", href: "/serveravatar", icon: Boxes, accent: "sa" },
  { label: "Cloudflare", href: "/cloudflare", icon: Cloud, badgeKey: "cf_keys", accent: "cloudflare" },
  { label: "Watcher", href: "/watcher", icon: Activity, badgeKey: "active_watchers", accent: "watcher" },
  { label: "Logs", href: "/logs", icon: ScrollText, accent: "logs" },
  { label: "Audit Log", href: "/audit", icon: ShieldCheck, accent: "audit" },
  { label: "Settings", href: "/settings", icon: Settings, accent: "settings" },
]
