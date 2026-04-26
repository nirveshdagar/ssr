import * as React from "react"
import { AppSidebar } from "./app-sidebar"
import { TopBar } from "./top-bar"

export type PageAccent =
  | "dashboard"
  | "domains"
  | "servers"
  | "cloudflare"
  | "watcher"
  | "logs"
  | "audit"
  | "settings"

interface AppShellProps {
  title: string
  description?: string
  breadcrumbs?: { label: string; href?: string }[]
  actions?: React.ReactNode
  accent?: PageAccent
  children: React.ReactNode
}

export function AppShell({ title, description, breadcrumbs, actions, accent, children }: AppShellProps) {
  return (
    <div className="flex min-h-screen w-full bg-background">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} description={description} breadcrumbs={breadcrumbs} actions={actions} accent={accent} />
        <main className="flex-1 px-4 lg:px-6 py-5 lg:py-6">{children}</main>
      </div>
    </div>
  )
}
