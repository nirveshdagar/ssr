import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { setupTestDb, cleanupTestDb } from "./_setup"

beforeAll(() => { setupTestDb() })
afterAll(() => { cleanupTestDb() })

beforeEach(async () => {
  const { run } = await import("@/lib/db")
  run("DELETE FROM settings")
})

/**
 * Root cause of "many sites have no SSL": the safe, idempotent CF-Origin
 * cert self-heal (checkOriginCerts / force-https / SA-tracker) was gated
 * behind `auto_migrate_enabled`. An operator who turns migration OFF (the
 * false-dead stopgap) then gets NO SSL healing — even though the cert is
 * already in domains.origin_cert_pem. sslHealEnabled() is the dedicated,
 * DEFAULT-ON replacement gate, independent of auto_migrate_enabled.
 */
describe("sslHealEnabled — safe SSL self-heal gate, default ON", () => {
  it("defaults ON when the setting is unset (the fix)", async () => {
    const { sslHealEnabled } = await import("@/lib/auto-heal")
    expect(sslHealEnabled()).toBe(true)
  })

  it("ON for explicit '1'", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { sslHealEnabled } = await import("@/lib/auto-heal")
    setSetting("auto_ssl_heal_enabled", "1")
    expect(sslHealEnabled()).toBe(true)
  })

  it("OFF only when explicitly set to '0'", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { sslHealEnabled } = await import("@/lib/auto-heal")
    setSetting("auto_ssl_heal_enabled", "0")
    expect(sslHealEnabled()).toBe(false)
  })

  it("blank / whitespace falls back to ON (never silently off)", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { sslHealEnabled } = await import("@/lib/auto-heal")
    setSetting("auto_ssl_heal_enabled", "   ")
    expect(sslHealEnabled()).toBe(true)
  })

  it("is INDEPENDENT of auto_migrate_enabled (the whole point)", async () => {
    const { setSetting } = await import("@/lib/repos/settings")
    const { sslHealEnabled } = await import("@/lib/auto-heal")
    setSetting("auto_migrate_enabled", "0") // migration OFF…
    expect(sslHealEnabled()).toBe(true)     // …SSL still heals
  })
})
