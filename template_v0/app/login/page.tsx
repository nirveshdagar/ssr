"use client"

import * as React from "react"
import Link from "next/link"
import { Server, Lock, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group"

export default function LoginPage() {
  const [pwd, setPwd] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setTimeout(() => setLoading(false), 600)
  }

  return (
    <main className="grid min-h-screen w-full place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-[360px]">
        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Server className="h-5 w-5" aria-hidden />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-base font-semibold tracking-tight">SSR Dashboard</h1>
            <p className="text-small text-muted-foreground">Site Server Rotation — internal access only</p>
          </div>
        </div>

        {/* Card */}
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

              <Button type="submit" className="w-full gap-1.5" disabled={loading || pwd.length === 0}>
                {loading ? "Signing in…" : "Sign in"}
                {!loading && <ArrowRight className="h-3.5 w-3.5" />}
              </Button>
            </FieldGroup>
          </form>
        </div>

        {/* Meta */}
        <div className="mt-6 flex items-center justify-between text-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
            <span className="font-mono uppercase tracking-wider">PROD</span>
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
