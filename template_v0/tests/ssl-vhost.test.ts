import { describe, expect, it } from "vitest"
import { synthesizeVhosts } from "@/lib/ssl-vhost"

const base = {
  domain: "conceptden.site",
  appName: "conceptden-site",
  docRoot: "/home/purepacksite/conceptden-site/public_html",
  crtPath: "/etc/ssl/certs/conceptden-site.crt",
  keyPath: "/etc/ssl/private/conceptden-site.key",
}

describe("ssl-vhost — synthesizeVhosts", () => {
  it("derives appDir + logsDir from the docroot", () => {
    const v = synthesizeVhosts(base)
    expect(v.appDir).toBe("/home/purepacksite/conceptden-site")
    expect(v.logsDir).toBe("/home/purepacksite/conceptden-site/logs")
  })

  it(":443 vhost references OUR CF-Origin cert + key, not LE/default", () => {
    const { sslConf } = synthesizeVhosts(base)
    expect(sslConf).toContain("<VirtualHost *:443>")
    expect(sslConf).toContain("SSLCertificateFile /etc/ssl/certs/conceptden-site.crt")
    expect(sslConf).toContain("SSLCertificateKeyFile /etc/ssl/private/conceptden-site.key")
    expect(sslConf).not.toMatch(/letsencrypt|sadefault/)
    expect(sslConf).toContain("ServerName conceptden.site")
    expect(sslConf).toContain("DocumentRoot /home/purepacksite/conceptden-site/public_html")
    expect(sslConf).toContain("error-ssl.log")
    expect(sslConf).toContain("proxy:unix:/run/php/conceptden-site.sock|fcgi://conceptden-site/")
  })

  it(":80 vhost force-redirects to https with the idempotent sentinel", () => {
    const { httpConf } = synthesizeVhosts(base)
    expect(httpConf).toContain("<VirtualHost *:80>")
    expect(httpConf).toContain("# ssr-force-https")
    expect(httpConf).toContain("RewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=301,L]")
    expect(httpConf).toContain("error.log")
  })

  it("rejects unsafe inputs (injection-safety)", () => {
    expect(() => synthesizeVhosts({ ...base, appName: "a;rm -rf/" })).toThrow(/unsafe appName/)
    expect(() => synthesizeVhosts({ ...base, docRoot: "/etc/passwd" })).toThrow(/docRoot shape/)
    expect(() => synthesizeVhosts({ ...base, docRoot: "../../x/public_html" })).toThrow(/docRoot shape/)
  })
})
