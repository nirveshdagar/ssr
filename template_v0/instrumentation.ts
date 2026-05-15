/**
 * Next.js instrumentation hook.
 *
 * INTENTIONALLY EMPTY. The actual boot logic (job-handler registration,
 * worker pool start, SIGTERM handler, daily backup, log retention,
 * auto-heal sweeper) lives in `lib/boot-singleton.ts` and runs lazily on
 * the first `lib/db.ts:getDb()` call (i.e. the first /api/* request).
 *
 * Why lazy: Next.js 16 builds this file for BOTH the Node and Edge
 * runtimes. The Edge bundler traces every dynamic import even when
 * guarded by `if (process.env.NEXT_RUNTIME !== "nodejs") return`, and
 * chokes on patchright + ssh2 + node:fs + nodemailer. Keeping
 * instrumentation.ts empty means the Edge variant has no module graph
 * to trace, so the production build succeeds.
 *
 * Trade-off: ~50 ms tax on the first /api/* request. Subsequent
 * requests pay nothing — `started` short-circuits in boot-singleton.
 *
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */
export async function register(): Promise<void> {
  // No-op. See module docstring above.
}
