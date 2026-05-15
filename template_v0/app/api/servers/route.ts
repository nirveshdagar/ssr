import { NextResponse } from "next/server"
import { listServers } from "@/lib/repos/servers"

export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json({ servers: listServers() })
}
