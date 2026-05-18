import { describe, expect, it } from "vitest"
import { decideAppRebuild, rebuildNeedsSaDelete } from "@/lib/app-rebuild-guard"

const base = { recentRebuilds: 0, maxPerDay: 2, inflight: false }

describe("app-rebuild-guard — decideAppRebuild (destructive → conservative)", () => {
  it("scaffolded → skip (nothing wrong)", () => {
    expect(decideAppRebuild({ ...base, state: "scaffolded" })).toBe("skip")
  })
  it("unknown (SA/SSH error) → skip (never act on uncertainty)", () => {
    expect(decideAppRebuild({ ...base, state: "unknown" })).toBe("skip")
  })
  it("no-sa-app → rebuild", () => {
    expect(decideAppRebuild({ ...base, state: "no-sa-app" })).toBe("rebuild")
  })
  it("sa-app-no-dir → rebuild", () => {
    expect(decideAppRebuild({ ...base, state: "sa-app-no-dir" })).toBe("rebuild")
  })
  it("inflight → skip (don't stack a rebuild)", () => {
    expect(decideAppRebuild({ ...base, state: "no-sa-app", inflight: true })).toBe("skip")
  })
  it("hit per-day cap → giveup (SA itself broken → human)", () => {
    expect(decideAppRebuild({ ...base, state: "sa-app-no-dir", recentRebuilds: 2 })).toBe("giveup")
    expect(decideAppRebuild({ ...base, state: "no-sa-app", recentRebuilds: 5 })).toBe("giveup")
  })
})

describe("app-rebuild-guard — rebuildNeedsSaDelete", () => {
  it("only deletes a stale record when one exists (sa-app-no-dir)", () => {
    expect(rebuildNeedsSaDelete("sa-app-no-dir")).toBe(true)
    expect(rebuildNeedsSaDelete("no-sa-app")).toBe(false)
    expect(rebuildNeedsSaDelete("scaffolded")).toBe(false)
    expect(rebuildNeedsSaDelete("unknown")).toBe(false)
  })
})
