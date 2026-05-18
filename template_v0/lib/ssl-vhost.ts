/**
 * Deterministic Apache vhost synthesizer — PURE (no I/O, unit-tested).
 *
 * The SSH SSL tier used to *derive* the `:443` vhost from whatever `:80`
 * conf SA happened to leave behind. For the partial-create domains SA left
 * NO conf at all, so the tier had nothing to derive from, wrote no vhost,
 * yet still reported success → Apache fell through to 000-default-ssl
 * (the box self-signed cert) → "WRONG ISSUER" forever.
 *
 * Instead, build BOTH vhosts from first principles using the facts we
 * already know (domain, docroot, our CF-Origin cert/key paths). Mirrors
 * SA's own conf shape (verified on the box): ServerName + www alias,
 * DocumentRoot, ErrorLog/CustomLog under <appDir>/logs, the per-app
 * php-fpm proxy handler, force-HTTPS on :80, our cert on :443.
 */

export interface SynthVhosts {
  appDir: string   // /home/<user>/<appName>
  logsDir: string  // <appDir>/logs   (caller must mkdir -p — missing = fatal configtest)
  httpConf: string // *:80 vhost (+ force-https)
  sslConf: string  // *:443 vhost (CF Origin cert)
}

const SAFE = /^[A-Za-z0-9._-]+$/

/**
 * @param docRoot absolute `/home/<user>/<appName>/public_html`
 */
export function synthesizeVhosts(opts: {
  domain: string
  appName: string
  docRoot: string
  crtPath: string
  keyPath: string
}): SynthVhosts {
  const { domain, appName, docRoot, crtPath, keyPath } = opts
  if (!SAFE.test(appName)) throw new Error(`unsafe appName: ${appName}`)
  if (!/^\/[A-Za-z0-9._\/-]+\/public_html$/.test(docRoot)) {
    throw new Error(`unexpected docRoot shape: ${docRoot}`)
  }
  if (!SAFE.test(domain) && !/^[A-Za-z0-9.-]+$/.test(domain)) {
    throw new Error(`unsafe domain: ${domain}`)
  }
  const appDir = docRoot.replace(/\/public_html$/, "")
  const logsDir = `${appDir}/logs`
  const fpmSock = `/run/php/${appName}.sock`

  const common = (errLog: string, accLog: string) =>
    `\tServerName ${domain}\n` +
    `\tServerAlias ${domain} www.${domain}\n` +
    `\tDocumentRoot ${docRoot}\n\n` +
    `\tErrorLog ${logsDir}/${errLog}\n` +
    `\tCustomLog ${logsDir}/${accLog} combined\n\n` +
    `\t<Directory ${docRoot}>\n` +
    `\t\tOptions -Indexes +FollowSymLinks +MultiViews\n` +
    `\t\tAllowOverride All\n\t\tRequire all granted\n\t</Directory>\n\n` +
    `\t<IfModule proxy_fcgi_module>\n` +
    `\t\t<FilesMatch \\.php$>\n` +
    `\t\t\tSetHandler "proxy:unix:${fpmSock}|fcgi://${appName}/"\n` +
    `\t\t</FilesMatch>\n\t</IfModule>\n`

  const httpConf =
    `<VirtualHost *:80>\n` +
    common("error.log", "access.log") +
    `\n\t# ssr-force-https\n` +
    `\tRewriteEngine On\n` +
    `\tRewriteCond %{HTTPS} off\n` +
    `\tRewriteRule ^(.*)$ https://%{HTTP_HOST}$1 [R=301,L]\n` +
    `</VirtualHost>\n`

  const sslConf =
    `<VirtualHost *:443>\n` +
    common("error-ssl.log", "access-ssl.log") +
    `\n\tSSLEngine on\n` +
    `\tSSLCertificateFile ${crtPath}\n` +
    `\tSSLCertificateKeyFile ${keyPath}\n` +
    `\tProtocols h2 http/1.1\n` +
    `</VirtualHost>\n`

  return { appDir, logsDir, httpConf, sslConf }
}
