// READ-ONLY prod buy diagnostic. Run on the DO droplet:
//   cd /opt/ssr && git pull && node diag-prod-buy.mjs canvasdigital.site
// Dumps: domain row + status, registrant_* settings (decrypted, so we can
// see if they actually saved on PROD's separate DB), spaceship_contact_id,
// and the recent pipeline_log for the domain. No writes, no API calls.
import { readFileSync } from "node:fs"
import { createDecipheriv, createHmac } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

const domain = process.argv[2] || "canvasdigital.site"
const DB = process.argv[3] || "/opt/ssr/data/ssr.db"
const KEY = process.argv[4] || "/opt/ssr/data/.ssr_secret_fernet"
const MARK = "enc:v1:"
const ub64 = (s) => { const n = s.replace(/-/g,"+").replace(/_/g,"/"); return Buffer.from(n+"=".repeat((4-n.length%4)%4),"base64") }
const raw = ub64(readFileSync(KEY,"utf8").trim())
const K = { sign: raw.subarray(0,16), enc: raw.subarray(16,32) }
function dec(v){
  if(!v || !v.startsWith(MARK)) return v
  try{
    const d=ub64(v.slice(MARK.length)), hm=d.subarray(0,d.length-32)
    if(Buffer.compare(d.subarray(d.length-32),createHmac("sha256",K.sign).update(hm).digest())!==0) return "<HMAC-FAIL>"
    const dc=createDecipheriv("aes-128-cbc",K.enc,hm.subarray(9,25))
    return Buffer.concat([dc.update(hm.subarray(25)),dc.final()]).toString("utf8")
  }catch(e){ return "<DECRYPT-ERR:"+e.message+">" }
}

const db = new DatabaseSync(DB, { readOnly: true })
const g = (k) => { const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k); return r ? dec(r.value) : null }

console.log("=== prod domain row ===")
const d = db.prepare("SELECT id,domain,status,created_at,updated_at FROM domains WHERE domain=?").get(domain)
console.log(d ? JSON.stringify(d) : `NO ROW for ${domain} (never added on prod)`)

console.log("\n=== prod registrant + spaceship settings (decrypted) ===")
for (const k of ["spaceship_api_key","spaceship_api_secret","spaceship_contact_id",
  "registrant_first_name","registrant_last_name","registrant_email","registrant_phone",
  "registrant_address","registrant_city","registrant_state","registrant_zip","registrant_country"]) {
  const v = g(k)
  const show = k==="spaceship_api_secret" ? (v?`set(len ${v.length})`:"MISSING")
            : k==="spaceship_api_key" ? (v?`${v.slice(0,4)}…(len ${v.length})`:"MISSING")
            : (v===null ? "<<NOT SET>>" : v==="" ? "<<EMPTY>>" : v)
  console.log(k.padEnd(24), ":", show)
}

console.log("\n=== prod step_tracker step 1 ===")
for (const s of db.prepare("SELECT step_num,status,substr(message,1,260) m,finished_at FROM step_tracker WHERE domain=? AND step_num=1").all(domain))
  console.log(JSON.stringify(s))

console.log("\n=== last 14 pipeline_log for "+domain+" ===")
for (const r of db.prepare("SELECT id,step,status,substr(message,1,320) m,created_at FROM pipeline_log WHERE domain=? ORDER BY id DESC LIMIT 14").all(domain).reverse())
  console.log(`#${r.id} ${r.created_at} | ${r.step} | ${r.status}\n   ${r.m}`)
db.close()
