// لوحة المهام — GET يرجع الإحصائيات وأحدث المهام (تتحدث الواجهة كل ~5 ثوانٍ من هنا)
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/tasks";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  await ensureSchema();
  const sp = req.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(50, parseInt(sp.get("limit") || "20", 10) || 20));
  const type = sp.get("type") || undefined;
  const status = sp.get("status") || undefined;
  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, {
      type: type as never,
      status: status as never,
    }),
    taskStats(),
  ]);
  return NextResponse.json({ stats, tasks }, { headers: { "Cache-Control": "no-store" } });
}
