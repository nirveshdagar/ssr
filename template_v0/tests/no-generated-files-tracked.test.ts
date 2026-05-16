import { execSync } from "node:child_process"
import { describe, it, expect } from "vitest"

/**
 * Regression guard. Committing the Next-generated `next-env.d.ts` froze
 * prod for days: every `git pull` on the droplet aborted because each
 * build re-dirtied the tracked file, so deploys silently no-op'd. These
 * files MUST stay untracked (they're gitignored). If one is ever
 * re-added, this fails loudly in CI/local instead of on the next prod
 * deploy.
 */
describe("generated files must not be git-tracked", () => {
  it("git does not track next-env.d.ts or tsconfig.tsbuildinfo", () => {
    const tracked = execSync("git ls-files --full-name", { encoding: "utf8" })
    const offenders = tracked
      .split("\n")
      .filter(
        (f) =>
          /(^|\/)next-env\.d\.ts$/.test(f) ||
          /(^|\/)tsconfig\.tsbuildinfo$/.test(f),
      )
    expect(
      offenders,
      `generated files are tracked again (will freeze prod deploys): ${offenders.join(", ")}`,
    ).toEqual([])
  })
})
