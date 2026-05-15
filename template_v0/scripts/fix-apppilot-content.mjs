import { DatabaseSync } from "node:sqlite"

function unescapeDoubleEncoded(s) {
  if (!s || s.length < 100) return s
  const hasLiteralEscapes = /\\n|\\"|\\\\/.test(s)
  const hasRealNewlines = s.includes("\n")
  if (!hasLiteralEscapes || hasRealNewlines) return s
  const PH = "\0"
  return s
    .replace(/\\\\/g, PH)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(new RegExp(PH, "g"), "\\")
}

const db = new DatabaseSync("../data/ssr.db")
const row = db.prepare("SELECT site_html FROM domains WHERE domain = 'apppilot.site'").get()
const before = row.site_html
const after = unescapeDoubleEncoded(before)

console.log("before:", before.length, "bytes, real newlines:", before.includes("\n"))
console.log("after :", after.length,  "bytes, real newlines:", after.includes("\n"))
console.log("head:", JSON.stringify(after.slice(0, 200)))

if (before === after) {
  console.log("nothing to fix")
  process.exit(0)
}
db.prepare("UPDATE domains SET site_html = ? WHERE domain = 'apppilot.site'").run(after)
console.log("DB updated.")
