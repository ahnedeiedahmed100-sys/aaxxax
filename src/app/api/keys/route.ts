// إدارة المفاتيح — GET القائمة كاملة مع إخفاء دائم للمفاتيح (maskKey)، POST إضافة مع رفض التكرار
import { NextRequest, NextResponse } from "next/server";
import { listKeys, addKey } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";
import type { ProviderId } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function GET() {
  await ensureSchema();
  const keys = await listKeys(); // تعيد المفاتيح مُقنّعة دائمًا — بلا أي مفتاح كامل
  return NextResponse.json({ keys }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  await ensureSchema();
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  const provider = body.provider as ProviderId;
  const apiKey = (body.api_key as string || "").trim();
  const label = (body.label as string || "").trim();
  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود غير مدعوم — القيم المقبولة: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "أدخل مفتاح API صالحًا (8 أحرف على الأقل)" }, { status: 400 });
  }
  const result = await addKey(provider, apiKey, label);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
}
