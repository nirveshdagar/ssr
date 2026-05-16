import { execSync } from "node:child_process"

// Capture the git SHA + build time at build so the running app can report
// exactly which commit it's serving. The root cause of the 2026-05-16
// saga was prod silently running stale code with no way to tell at a
// glance. Falls back to "dev" when git is unavailable (won't fail build).
let gitSha = process.env.SSR_GIT_SHA || "dev"
try {
  gitSha =
    execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim() || gitSha
} catch {
  /* git missing / not a repo — keep fallback */
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    SSR_GIT_SHA: gitSha,
    SSR_BUILD_TIME: new Date().toISOString(),
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  // Heavy native + dynamic-require packages must run as Node externals
  // (Turbopack's eager static analysis can't follow patchright's dynamic
  // imports into playwright-core/lib/zipBundle, ssh2's native bindings, or
  // node-forge's UMD entry).
  serverExternalPackages: ["patchright", "patchright-core", "playwright-core", "ssh2", "nodemailer"],

  async headers() {
    // Security headers applied to every response.
    //
    // CSP intentionally permissive on script-src 'unsafe-inline' because
    // Next.js inlines its hydration bootstrap; tightening to nonces requires
    // wiring through every Server Component, which is a separate project.
    // The dashboard renders LLM-generated previews and audit-log strings —
    // both attacker-influenced — so any future XSS would be much worse
    // without these headers, even if CSP isn't fully nonce-locked.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://api.cloudflare.com https://api.digitalocean.com https://api.serveravatar.com https://spaceship.dev https://api.anthropic.com https://api.openai.com https://api.moonshot.ai https://openrouter.ai https://generativelanguage.googleapis.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]
  },
}

export default nextConfig
