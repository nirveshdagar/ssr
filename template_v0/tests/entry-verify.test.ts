import { describe, expect, it } from "vitest"
import { buildEntryProbeScript, classifyEntryVerify, decideEntryHeal } from "@/lib/entry-verify"

describe("entry-verify — probe script", () => {
  it("escapes the domain in the ServerName match (no regex injection)", () => {
    const s = buildEntryProbeScript("concept.den.site")
    expect(s).toContain("ServerName[[:space:]]+concept\\.den\\.site([[:space:]]|$)")
    expect(s).toContain("RESULT|NODR")
    expect(s).toContain("RESULT|MISSING")
  })
})

describe("entry-verify — classify (asymmetric: only definitive misses fail)", () => {
  it("OK with bytes>0 → ok", () => {
    expect(classifyEntryVerify("RESULT|OK|50411|/home/u/a/public_html").verdict).toBe("ok")
  })
  it("OK but 0/garbage bytes → missing", () => {
    expect(classifyEntryVerify("RESULT|OK|0|/d").verdict).toBe("missing")
    expect(classifyEntryVerify("RESULT|OK||/d").verdict).toBe("missing")
  })
  it("EMPTY file → missing (definitive fail)", () => {
    expect(classifyEntryVerify("RESULT|EMPTY|0|/home/u/a/public_html").verdict).toBe("missing")
  })
  it("MISSING (docroot exists, no index.php) → missing (definitive fail)", () => {
    const v = classifyEntryVerify("RESULT|MISSING||/home/u/a/public_html")
    expect(v.verdict).toBe("missing")
    expect(v.detail).toMatch(/NO index\.php/)
  })
  it("NODR (no served vhost) → inconclusive (vhost-guard's job, NOT step 10's)", () => {
    expect(classifyEntryVerify("RESULT|NODR||").verdict).toBe("inconclusive")
  })
  it("no RESULT line / ssh failure → inconclusive (never regress a real success)", () => {
    expect(classifyEntryVerify("").verdict).toBe("inconclusive")
    expect(classifyEntryVerify("bash: command not found").verdict).toBe("inconclusive")
  })
  it("unknown state → inconclusive", () => {
    expect(classifyEntryVerify("RESULT|WAT||").verdict).toBe("inconclusive")
  })
})

describe("entry-verify — decideEntryHeal (auto-heal cap logic)", () => {
  const base = { recentFailures: 0, maxPerHour: 3, inflight: false }
  it("non-missing verdict never acts", () => {
    expect(decideEntryHeal({ ...base, verdict: "ok" })).toBe("skip")
    expect(decideEntryHeal({ ...base, verdict: "inconclusive" })).toBe("skip")
  })
  it("missing + under cap + no inflight → act", () => {
    expect(decideEntryHeal({ ...base, verdict: "missing" })).toBe("act")
    expect(decideEntryHeal({ ...base, verdict: "missing", recentFailures: 2 })).toBe("act")
  })
  it("missing + at/over cap → giveup (no infinite re-upload loop)", () => {
    expect(decideEntryHeal({ ...base, verdict: "missing", recentFailures: 3 })).toBe("giveup")
    expect(decideEntryHeal({ ...base, verdict: "missing", recentFailures: 9 })).toBe("giveup")
  })
  it("missing + inflight (job already queued) → skip (don't stack)", () => {
    expect(decideEntryHeal({ ...base, verdict: "missing", inflight: true })).toBe("skip")
  })
})
