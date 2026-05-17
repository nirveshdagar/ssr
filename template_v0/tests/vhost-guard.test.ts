import { describe, expect, it } from "vitest"
import {
  parseVhostProbe, decideQuarantine, brokenReasons, confToDomain,
} from "@/lib/vhost-guard"

// Mirrors the REAL 2026-05-17 savanna outage: configtest AH00014 because
// conceptden's error-log dir is gone; every other vhost is fine.
const REAL_BROKEN = `CONFIGTEST_START
AH00112: Warning: DocumentRoot [/home/purepacksite/conceptden-site/public_html] does not exist
AH00558: apache2: Could not reliably determine the server's fully qualified domain name
(2)No such file or directory: AH02291: Cannot access directory '/home/purepacksite/conceptden-site/logs/' for error log of vhost defined at /etc/apache2/sites-enabled/conceptden-site-le-ssl.conf:1
AH00014: Configuration check failed
CONFIGTEST_END rc=1
VHOST|/etc/apache2/sites-enabled/conceptden-site-le-ssl.conf|dr=/home/purepacksite/conceptden-site/public_html|drx=N|eld=/home/purepacksite/conceptden-site/logs|elx=N
VHOST|/etc/apache2/sites-enabled/purepack-site-ssl.conf|dr=/home/purepacksite/purepack-site/public_html|drx=Y|eld=/home/purepacksite/purepack-site/logs|elx=Y
VHOST|/etc/apache2/sites-enabled/growthhustle-site.conf|dr=/home/purepacksite/growthhustle-site/public_html|drx=Y|eld=/home/purepacksite/growthhustle-site/logs|elx=Y`

const HEALTHY = `CONFIGTEST_START
AH00558: apache2: Could not reliably determine the server's fully qualified domain name
Syntax OK
CONFIGTEST_END rc=0
VHOST|/etc/apache2/sites-enabled/purepack-site-ssl.conf|dr=/home/purepacksite/purepack-site/public_html|drx=Y|eld=/home/purepacksite/purepack-site/logs|elx=Y`

// configtest fails but every dir exists → cause is something else; DO NOT act.
const FAIL_BUT_DIRS_OK = `CONFIGTEST_START
Invalid command 'Frobnicate', perhaps misspelled
AH00014: Configuration check failed
CONFIGTEST_END rc=1
VHOST|/etc/apache2/sites-enabled/purepack-site-ssl.conf|dr=/home/purepacksite/purepack-site/public_html|drx=Y|eld=/home/purepacksite/purepack-site/logs|elx=Y`

describe("vhost-guard — parse", () => {
  it("parses the real broken probe: configtest NOT ok, 3 vhosts", () => {
    const p = parseVhostProbe(REAL_BROKEN)
    expect(p.configtestOk).toBe(false)
    expect(p.vhosts).toHaveLength(3)
    const c = p.vhosts.find((v) => v.conf.includes("conceptden"))!
    expect(c.documentRootExists).toBe(false)
    expect(c.errorLogDirExists).toBe(false)
    const ok = p.vhosts.find((v) => v.conf.includes("purepack"))!
    expect(ok.documentRootExists).toBe(true)
    expect(ok.errorLogDirExists).toBe(true)
  })

  it("treats rc=0 / Syntax OK as healthy (AH00558 is only a warning)", () => {
    expect(parseVhostProbe(HEALTHY).configtestOk).toBe(true)
  })
})

describe("vhost-guard — decide (conservative)", () => {
  it("quarantines ONLY conceptden on the real outage probe", () => {
    const d = decideQuarantine(parseVhostProbe(REAL_BROKEN))
    expect(d.act).toBe(true)
    expect(d.quarantine).toHaveLength(1)
    expect(d.quarantine[0].conf).toContain("conceptden")
    expect(d.quarantine[0].reasons.join(" ")).toMatch(/ErrorLog dir missing/)
  })

  it("does NOTHING when apache config is healthy", () => {
    const d = decideQuarantine(parseVhostProbe(HEALTHY))
    expect(d.act).toBe(false)
    expect(d.quarantine).toHaveLength(0)
  })

  it("does NOT touch config when configtest fails but all dirs exist (unknown cause → human)", () => {
    const d = decideQuarantine(parseVhostProbe(FAIL_BUT_DIRS_OK))
    expect(d.act).toBe(false)
    expect(d.quarantine).toHaveLength(0)
    expect(d.reason).toMatch(/needs a human/)
  })
})

describe("vhost-guard — helpers", () => {
  it("brokenReasons flags each missing piece independently", () => {
    expect(brokenReasons({
      conf: "x", documentRoot: "/a", documentRootExists: true,
      errorLogDir: "/a/logs", errorLogDirExists: false,
    })).toEqual(["ErrorLog dir missing: /a/logs"])
    expect(brokenReasons({
      conf: "x", documentRoot: "/a", documentRootExists: true,
      errorLogDir: "/a/logs", errorLogDirExists: true,
    })).toEqual([])
  })

  it("confToDomain strips SA suffixes", () => {
    expect(confToDomain("/etc/apache2/sites-enabled/conceptden-site-le-ssl.conf")).toBe("conceptden")
    expect(confToDomain("/etc/apache2/sites-enabled/purepack-site.conf")).toBe("purepack")
  })
})
