import {
  LayoutDashboard,
  Globe,
  Server,
  Cloud,
  Activity,
  ScrollText,
  ShieldCheck,
  Settings,
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

export type NavItem = {
  label: string
  href: string
  icon: LucideIcon
  badge?: string | number
  accent: NavAccent
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard, accent: "dashboard" },
  { label: "Domains", href: "/domains", icon: Globe, badge: 248, accent: "domains" },
  { label: "Servers", href: "/servers", icon: Server, badge: 14, accent: "servers" },
  { label: "Cloudflare", href: "/cloudflare", icon: Cloud, badge: 6, accent: "cloudflare" },
  { label: "Watcher", href: "/watcher", icon: Activity, badge: 3, accent: "watcher" },
  { label: "Logs", href: "/logs", icon: ScrollText, accent: "logs" },
  { label: "Audit Log", href: "/audit", icon: ShieldCheck, accent: "audit" },
  { label: "Settings", href: "/settings", icon: Settings, accent: "settings" },
]
