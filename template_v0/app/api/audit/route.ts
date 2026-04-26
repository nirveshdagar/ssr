import { NextResponse, type NextRequest } from "next/server"
import { listActionCounts, searchAuditLog } from "@/lib/repos/audit"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const action = url.searchParams.get("action")?.trim() || null
  const search = url.searchParams.get("q")?.trim() || null
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1)
  const PAGE_SIZE = 50
  const { rows, total } = searchAuditLog({ action, search, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  return NextResponse.json({
    rows,
    total,
    actions: listActionCounts(),
    page,
    last_page: lastPage,
    page_size: PAGE_SIZE,
  })
}
