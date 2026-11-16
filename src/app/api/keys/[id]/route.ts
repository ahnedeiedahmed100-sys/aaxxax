// تعطيل/تنشيط يدوي للمفتاح وحذفه — PATCH {status:"disabled"|"active"} و DELETE
import { NextRequest, NextResponse } from "next/server";
import { setKeyStatus, deleteKey } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const status = body?.status;
  if (status !== "disabled" && status !== "active") {
    return NextResponse.json({ error: "الحالة المقبولة: disabled أو active" }, { status: 400 });
  }
  const ok = await setKeyStatus(id, status);
  if (!ok) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true, status });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ensureSchema();
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
