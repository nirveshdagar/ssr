import { describe, expect, it } from "vitest"
import {
  decideDuplicateCleanup, appDomain, extractDocRoot, appNameForDomain,
  type DupApp,
} from "@/lib/dup-app-guard"

const KNOWN = ["conceptden.site", "purepack.site"]

function app(id: string, name: string, docRoot: string | null, pd?: string): DupApp {
  return { id, name, docRoot, primaryDomain: pd ?? name.replace(/-site$/, ".site") }
}

describe("dup-app-guard — helpers", () => {
  it("appNameForDomain mirrors SA convention", () => {
    expect(appNameForDomain("conceptden.site")).toBe("conceptden-site")
  })
  it("extractDocRoot reads loose SA objects, ignores junk", () => {
    expect(extractDocRoot({ document_root: "/home/u/x/public_html" })).toBe("/home/u/x/public_html")
    expect(extractDocRoot({ path: "/home/u/y" })).toBe("/home/u/y")
    expect(extractDocRoot({ document_root: "not-abs" })).toBeNull()
    expect(extractDocRoot({})).toBeNull()
  })
  it("appDomain matches by primary_domain or app name", () => {
    expect(appDomain(app("1", "conceptden-site", "/x"), KNOWN)).toBe("conceptden.site")
    expect(appDomain({ id: "2", name: "x", docRoot: "/x", primaryDomain: "www.purepack.site" }, KNOWN)).toBe("purepack.site")
    expect(appDomain({ id: "3", name: "other", docRoot: "/x", primaryDomain: "nope.com" }, KNOWN)).toBeNull()
  })
})

describe("dup-app-guard — decide (DESTRUCTIVE → maximally conservative)", () => {
  const exists = (real: string[]): (d: string) => boolean | undefined =>
    (d) => real.includes(d) ? true : false

  it("the real case: 2 conceptden apps, one serving + one empty → delete ONLY the empty", () => {
    const apps = [
      app("100", "conceptden-site", "/home/purepacksite/conceptden-site/public_html"),
      app("205", "conceptden-site", "/home/purepacksite/conceptden-site-dup/public_html"),
    ]
    const d = decideDuplicateCleanup(apps, KNOWN, exists(["/home/purepacksite/conceptden-site/public_html"]))
    expect(d).toHaveLength(1)
    expect(d[0].act).toBe(true)
    expect(d[0].keep).toBe("100")
    expect(d[0].delete).toEqual(["205"])
  })

  it("single app → never a duplicate set, no decision", () => {
    expect(decideDuplicateCleanup([app("1", "purepack-site", "/p")], KNOWN, exists(["/p"]))).toHaveLength(0)
  })

  it("BOTH apps have files (2 real installs) → ambiguous, SKIP (never delete)", () => {
    const apps = [app("1", "purepack-site", "/a"), app("2", "purepack-site", "/b")]
    const d = decideDuplicateCleanup(apps, KNOWN, exists(["/a", "/b"]))
    expect(d[0].act).toBe(false)
    expect(d[0].delete).toEqual([])
    expect(d[0].reason).toMatch(/ambiguous|human/)
  })

  it("NONE have files → skip (rebuild's job, not cleanup's)", () => {
    const apps = [app("1", "purepack-site", "/a"), app("2", "purepack-site", "/b")]
    const d = decideDuplicateCleanup(apps, KNOWN, exists([]))
    expect(d[0].act).toBe(false)
    expect(d[0].delete).toEqual([])
  })

  it("unknown dir state for any app → SKIP whole group (no delete on uncertainty)", () => {
    const apps = [app("1", "purepack-site", "/a"), app("2", "purepack-site", "/b")]
    const d = decideDuplicateCleanup(apps, KNOWN, (dr) => dr === "/a" ? true : undefined)
    expect(d[0].act).toBe(false)
    expect(d[0].reason).toMatch(/unknown|human/)
  })

  it("app with no resolvable doc root in a dup group → SKIP whole group", () => {
    const apps = [app("1", "purepack-site", "/a"), app("2", "purepack-site", null)]
    const d = decideDuplicateCleanup(apps, KNOWN, exists(["/a"]))
    expect(d[0].act).toBe(false)
    expect(d[0].reason).toMatch(/document root|human/)
  })

  it("3 apps: 1 serving + 2 empty → keep the server, delete both empties", () => {
    const apps = [
      app("9", "purepack-site", "/real"),
      app("10", "purepack-site", "/e1"),
      app("11", "purepack-site", "/e2"),
    ]
    const d = decideDuplicateCleanup(apps, KNOWN, exists(["/real"]))
    expect(d[0].act).toBe(true)
    expect(d[0].keep).toBe("9")
    expect(d[0].delete.sort()).toEqual(["10", "11"])
  })
})
