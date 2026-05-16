/**
 * Copy text to the clipboard, working over plain HTTP too.
 *
 * `navigator.clipboard` only exists in a *secure context* (HTTPS or
 * localhost). The prod dashboard is served over plain HTTP on the
 * droplet, so `navigator.clipboard` is `undefined` there and every
 * copy button threw "Cannot read properties of undefined (reading
 * 'writeText')". This tries the modern API, then falls back to the
 * legacy execCommand+textarea path which works in insecure contexts.
 *
 * Returns true on success so callers can show accurate feedback.
 */
export async function copyText(text: string): Promise<boolean> {
  // Modern API — only when actually available (secure context).
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* permission denied / not focused — fall through to legacy path */
  }

  // Legacy fallback — works over HTTP.
  try {
    if (typeof document === "undefined") return false
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "-9999px"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
