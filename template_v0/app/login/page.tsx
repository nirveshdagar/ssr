"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
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
  const params = useSearchParams()
  // Reject any `next` that isn't a same-origin path. Open-redirect prevention:
  // a phisher who linked /login?next=https://evil.com/clone could otherwise
  // bounce a successfully-authenticated operator to a credential-harvest clone.
  // Same-origin paths start with "/" and never with "//" (which is a
  // protocol-relative URL).
  const rawNext = params.get("next") || "/"
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/"
  const [pwd, setPwd] = React.useState("")
  const [pwdConfirm, setPwdConfirm] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [env, setEnv] = React.useState<"LOCAL" | "PROD">("PROD")
  // null = haven't probed yet; true = first-boot setup mode; false = normal sign-in
  const [needsSetup, setNeedsSetup] = React.useState<boolean | null>(null)
  React.useEffect(() => { setEnv(detectEnv()) }, [])
  // Probe whether a dashboard password has been configured. Public endpoint —
  // returns only `{ needs_setup: bool }`, leaks nothing else.
  React.useEffect(() => {
    fetch("/api/auth/setup-status", { credentials: "same-origin" })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { needs_setup?: boolean }
        setNeedsSetup(j.needs_setup === true)
      })
      .catch(() => { setNeedsSetup(false) /* fail-closed: assume sign-in mode */ })
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // First-boot path: create the password and auto-login.
    if (needsSetup) {
      if (pwd.length < 12) { setError("Password must be at least 12 characters"); return }
      if (pwd !== pwdConfirm) { setError("Passwords don't match"); return }
      setLoading(true)
      try {
        const r = await fetch("/api/auth/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: pwd }),
          credentials: "same-origin",
        })
        if (r.ok) { window.location.assign(next); return }
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        setError(j.error ?? `Setup failed (HTTP ${r.status})`)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
      return
    }

    // Normal sign-in path.
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
            <h1 className="text-base font-semibold tracking-tight">
              {needsSetup ? "First-boot setup" : "SSR Dashboard"}
            </h1>
            <p className="text-small text-muted-foreground">
              {needsSetup
                ? "Choose an operator password — minimum 12 characters."
                : "Site Server Rotation — internal access only"}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          <form onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="password" className="text-[13px]">
                  {needsSetup ? "New operator password" : "Operator password"}
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
                    autoComplete={needsSetup ? "new-password" : "current-password"}
                    placeholder={needsSetup ? "Choose a password (min 12 chars)" : "Enter password"}
                    value={pwd}
                    onChange={(e) => setPwd(e.target.value)}
                    required
                  />
                </InputGroup>
                <FieldDescription className="text-micro">
                  Single-operator tool. No SSO, no signup, no recovery.
                </FieldDescription>
              </Field>

              {needsSetup && (
                <Field>
                  <FieldLabel htmlFor="password-confirm" className="text-[13px]">
                    Confirm password
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <Lock className="h-3.5 w-3.5" aria-hidden />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="password-confirm"
                      name="password-confirm"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Re-type password"
                      value={pwdConfirm}
                      onChange={(e) => setPwdConfirm(e.target.value)}
                      required
                    />
                  </InputGroup>
                </Field>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-md border border-status-terminal/40 bg-status-terminal/10 px-3 py-2 text-small text-status-terminal">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                className="w-full gap-1.5"
                disabled={loading || pwd.length === 0 || (needsSetup === true && pwdConfirm.length === 0)}
              >
                {loading
                  ? (needsSetup ? "Creating…" : "Signing in…")
                  : (needsSetup ? "Create password & sign in" : "Sign in")}
                {!loading && <ArrowRight className="h-3.5 w-3.5" />}
              </Button>
            </FieldGroup>
          </form>
        </div>

        {needsSetup && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-status-waiting/40 bg-status-waiting/10 px-3 py-2 text-micro text-status-waiting"
          >
            <strong>First boot:</strong> no password is configured yet. The password you set here will gate every future visit.
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
          {/* "Skip to dashboard" link removed — middleware redirects unauth
              users back to /login anyway, so it was a dead UI affordance. */}
        </div>
      </div>
    </main>
  )
}
