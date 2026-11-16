// GET /api/health — الجهوزية العامة: قاعدة البيانات، مسار MCP، الموديلات، خدمة الدمج، حالة التوثيق
import { NextResponse } from "next/server";
import { dbHealthy, isTursoConfigured } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerConfig, MERGER_BASE } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [healthy, merger] = await Promise.all([dbHealthy(), mergerConfig()]);
  // تقرير صادق: turso-connected عند ضبط رابط Turso فعليًا، local-dev في وضع ملف التطوير، unavailable عند الفشل
  const database = !healthy ? "unavailable" : isTursoConfigured() ? "turso-connected" : "local-dev";
  return NextResponse.json(
    {
      ok: healthy,
      database,
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: { base: MERGER_BASE, healthy: merger.healthy },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
