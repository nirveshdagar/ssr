"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Server, Lock, ArrowRight, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

function detectEnv(): "LOCAL" | "PROD" {
  if (typeof window === "undefined") return "PROD"
  const h = window.location.hostname
  if (
    h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" ||
    h.endsWith(".local") || h.endsWith(".localhost") ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) return "LOCAL"
  return "PROD"
}

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginPageInner />
    </React.Suspense>
  )
}

function LoginPageInner() {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get("next") || "/"
  const [pwd, setPwd] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [openAccess, setOpenAccess] = React.useState(false)
  const [env, setEnv] = React.useState<"LOCAL" | "PROD">("PROD")
  React.useEffect(() => { setEnv(detectEnv()) }, [])
  // Probe whether a dashboard password is configured. We DON'T expose the
  // hash — `/api/auth/login` returns 500 with a specific message when not set.
  // The login form sends a sentinel byte to trigger that path without leaking.
  React.useEffect(() => {
    const fd = new FormData()
    fd.set("password", "__probe__no_match__")
    fetch("/api/auth/login", { method: "POST", body: fd, credentials: "same-origin" })
      .then(async (r) => {
        if (r.status === 500) {
          const j = (await r.json().catch(() => ({}))) as { error?: string }
          if ((j.error ?? "").includes("No dashboard password configured")) {
            setOpenAccess(true)
          }
        }
      })
      .catch(() => { /* non-fatal */ })
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const fd = new FormData()
      fd.set("password", pwd)
      const r = await fetch("/api/auth/login", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      })
      if (r.ok) {
        // Hard redirect so the iron-session cookie is sent on the very next
        // request — `router.push` would re-run client side without the cookie
        // arriving in time on slow network.
        window.location.assign(next)
        return
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string; retry_after?: number }
      if (r.status === 429) {
        setError(j.error ?? "Too many attempts. Try again later.")
      } else if (r.status === 401) {
        setError(j.error ?? "Invalid password")
      } else {
        setError(j.error ?? `HTTP ${r.status}`)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="grid min-h-screen w-full place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Server className="h-5 w-5" aria-hidden />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold tracking-tight">SSR Dashboard</h1>
            <p className="text-small text-muted-foreground">Site Server Rotation — internal access only</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <form onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="password" className="text-[13px]">
                  Operator password
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <Lock className="h-3.5 w-3.5" aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="password"
                    name="password"
                    type="password"
                    autoFocus
                    autoComplete="current-password"
                    placeholder="Enter password"
                    value={pwd}
                    onChange={(e) => setPwd(e.target.value)}
                    required
                  />
                </InputGroup>
                <FieldDescription className="text-micro">
                  Single-operator tool. No SSO, no signup, no recovery.
                </FieldDescription>
              </Field>

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-status-terminal/40 bg-status-terminal/10 px-3 py-2 text-small text-status-terminal">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full gap-1.5" disabled={loading || pwd.length === 0}>
                {loading ? "Signing in…" : "Sign in"}
                {!loading && <ArrowRight className="h-3.5 w-3.5" />}
              </Button>
            </FieldGroup>
          </form>
        </div>

        {openAccess && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-status-waiting/40 bg-status-waiting/10 px-3 py-2 text-micro text-status-waiting"
          >
            <strong>Open-access mode:</strong> no dashboard password configured. Set one in Settings → Security to gate the dashboard.
          </div>
        )}
        <div className="mt-6 flex items-center justify-between text-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                env === "LOCAL" ? "bg-[color:var(--success)]" : "bg-destructive",
              )}
              aria-hidden
            />
            <span className="font-mono uppercase tracking-wider">{env}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">v1.4.2</span>
          </span>
          <Link href="/" className="hover:text-foreground transition-colors">
            Skip to dashboard
          </Link>
        </div>
      </div>
    </main>
  )
}
