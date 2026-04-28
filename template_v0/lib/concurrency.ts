/**
 * Tiny async semaphore for capping fan-out on heavy resources.
 *
 * Used around:
 *   - patchright Chromium launches in serveravatar-ui.ts (each browser is
 *     ~300 MB; 50 simultaneous launches would hit ~15 GB and choke a small
 *     box even though the dashboard process is otherwise lean)
 *   - Anthropic LLM calls in website-generator.ts (cap concurrent
 *     in-flight requests below the per-account rate limit)
 *
 * Instances live on globalThis so HMR re-evaluation reuses the same
 * underlying queue — otherwise a dev-mode edit could double the effective
 * cap mid-flight by handing out fresh permits from a new semaphore while
 * old holders are still mid-task.
 */

declare global {
  // eslint-disable-next-line no-var
  var __ssrSemaphores: Map<string, Semaphore> | undefined
}

class Semaphore {
  private inFlight = 0
  private waiters: Array<() => void> = []
  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.capacity) {
      this.inFlight++
      return () => this.release()
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this.inFlight--
    const next = this.waiters.shift()
    if (next) next()
  }

  /** For diagnostics: current in-flight + queue depth. */
  stats(): { inFlight: number; waiting: number; capacity: number } {
    return { inFlight: this.inFlight, waiting: this.waiters.length, capacity: this.capacity }
  }
}

/** Get-or-create a named semaphore. Cap can be overridden via env var. */
export function getSemaphore(name: string, defaultCapacity: number): Semaphore {
  const map = (globalThis.__ssrSemaphores ??= new Map<string, Semaphore>())
  const existing = map.get(name)
  if (existing) return existing
  const cap = Math.max(1, defaultCapacity)
  const sem = new Semaphore(cap)
  map.set(name, sem)
  return sem
}

/** Convenience: acquire, run fn, always release. */
export async function withSemaphore<T>(
  name: string, defaultCapacity: number, fn: () => Promise<T>,
): Promise<T> {
  const release = await getSemaphore(name, defaultCapacity).acquire()
  try {
    return await fn()
  } finally {
    release()
  }
}
