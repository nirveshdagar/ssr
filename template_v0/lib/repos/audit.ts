import { all, one, run } from "../db"

export interface AuditRow {
  id: number
  created_at: string
  actor_ip: string | null
  action: string
  target: string | null
  detail: string | null
}

export interface AuditSearchOpts {
  action?: string | null
  search?: string | null
  limit?: number
  offset?: number
}

export function searchAuditLog(opts: AuditSearchOpts = {}): { rows: AuditRow[]; total: number } {
  const where: string[] = []
  const args: (string | number)[] = []
  if (opts.action) {
    where.push("action = ?")
    args.push(opts.action)
  }
  if (opts.search) {
    where.push("(target LIKE ? OR detail LIKE ? OR actor_ip LIKE ?)")
    const like = `%${opts.search}%`
    args.push(like, like, like)
  }
  const whereClause = where.length ? ` WHERE ${where.join(" AND ")}` : ""
  const totalRow = one<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log${whereClause}`, ...args)
  const limit = opts.limit ?? 50
  const offset = opts.offset ?? 0
  const rows = all<AuditRow>(
    `SELECT * FROM audit_log${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...args,
    limit,
    offset,
  )
  return { rows, total: totalRow?.n ?? 0 }
}

export function listActionCounts(): { action: string; n: number }[] {
  return all(
    `SELECT action, COUNT(*) AS n FROM audit_log
      GROUP BY action ORDER BY n DESC, action ASC`,
  )
}

export function appendAudit(action: string, target: string, detail: string, actorIp: string | null = null): void {
  run(
    "INSERT INTO audit_log (actor_ip, action, target, detail) VALUES (?, ?, ?, ?)",
    actorIp || "",
    action,
    target,
    detail.slice(0, 1000),
  )
}
