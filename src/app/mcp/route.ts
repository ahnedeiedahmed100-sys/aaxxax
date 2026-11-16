// خادم MCP على المسار /mcp — نقل Streamable HTTP عبر SDK الرسمي في نمط stateless.
// في SDK 1.32 نقل Web Standards الرسمي هو WebStandardStreamableHTTPServerTransport،
// وهو نفسه ما يفوّض إليه StreamableHTTPServerTransport داخليًا (غلاف Node عبر @hono/node-server)،
// ونستخدمه هنا مباشرة لأن App Router يعطي Request/Response قياسية فورًا — بلا أي جسر وسيط.
// نمط stateless (بلا جلسات في الذاكرة) هو الأنسب لبيئات serverless مثل Vercel.
// POST = رسائل JSON-RPC (مجرى SSE يدفع التقدم الحي ثم الرد النهائي ويُغلق تلقائيًا من الـ SDK)؛
// DELETE = إنهاء الجلسة (لا جلسات في stateless → 405)؛ OPTIONS = CORS للراحة.
// عند ضبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>.
import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools, arabicMergePrecheck, SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/mcp/tools";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN || "";

function unauthorized(): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Authorization required — أضف ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" }, id: null },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}

function checkAuth(req: NextRequest): boolean {
  if (!MCP_ACCESS_TOKEN) return true; // التوثيق اختياري — غير مفعّل افتراضيًا
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${MCP_ACCESS_TOKEN}`;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

async function handlePost(req: NextRequest): Promise<Response> {
  if (!checkAuth(req)) return unauthorized();

  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error — جسم الطلب ليس JSON صالحًا" }, id: null },
      { status: 400, headers: corsHeaders() }
    );
  }

  // تهيئة قاعدة البيانات عند أول وصول
  await ensureSchema().catch((e) => console.error("[mcp] فشل تهيئة المخطط:", e));

  // رسائل الرفض العربية لقواعد الدمج (معيار 9) قبل وصولها للتحقق الرسمي بالمخطط
  const arabicViolation = arabicMergePrecheck(parsedBody);
  if (arabicViolation) {
    const id = (parsedBody as { id?: unknown }).id ?? null;
    return NextResponse.json(
      { jsonrpc: "2.0", result: { content: [{ type: "text", text: arabicViolation }], isError: true }, id },
      { headers: corsHeaders() }
    );
  }

  // نقل + خادم جديدان لكل طلب (نمط stateless الرسمي للـ serverless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // بلا جلسات
  });
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);

  const cleanup = async () => {
    try { await transport.close(); } catch { /* أُغلق سابقًا */ }
    try { await server.close(); } catch { /* تجاهل */ }
  };

  try {
    await server.connect(transport);
    // نمرر الجسم محلولًا — Next.js استهلك الـ body بالفعل عند req.json()
    const webRes = await transport.handleRequest(req, { parsedBody });

    // مهم: في نمط SSE يعيد handleRequest الاستجابة فورًا ويستمر تنفيذ الأداة في الخلفية
    // ويكتب التقدم الحي والرد النهائي في المجرى نفسه (والـ SDK يغلق المجرى بعد الرد النهائي) —
    // لذا لا نغلق النقل هنا (سيقتل المجرى) بل نراقب نهايته للتنظيف فقط.
    let body: ReadableStream<Uint8Array> | null = webRes.body;
    if (body) {
      const transformer: Transformer<Uint8Array, Uint8Array> = {
        transform(chunk, ctrl) { ctrl.enqueue(chunk); },
        flush() { void cleanup(); }, // اكتمل الرد النهائي — تنظيف آمن
      };
      // cancel متاح وقت التشغيل (انقطاع العميل) لكنه غائب عن تعريفات lib.dom في هذه النسخة
      (transformer as unknown as { cancel?: () => void }).cancel = () => { void cleanup(); };
      body = body.pipeThrough(new TransformStream(transformer));
    } else {
      void cleanup(); // رد JSON فوري بلا مجرى (مثل 202 للإشعارات)
    }

    const res = new Response(body, { status: webRes.status, headers: webRes.headers });
    for (const [k, v] of Object.entries(corsHeaders())) res.headers.set(k, v);
    return res;
  } catch (e) {
    console.error("[mcp] خطأ في معالجة الرسالة:", e);
    void cleanup();
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32603, message: `Internal server error: ${(e as Error).message}` }, id: null },
      { status: 500, headers: corsHeaders() }
    );
  }
}

function handleGet(): Response {
  // في نمط stateless لا يوجد مجرى SSE مستقل — 405 كما توصي المواصفة
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed — SSE standalone غير مدعوم في نمط stateless" }, id: null },
    { status: 405, headers: { Allow: "POST, DELETE, OPTIONS", ...corsHeaders() } }
  );
}

function handleDelete(): Response {
  // إنهاء الجلسة غير مطلوب في نمط stateless (لا جلسات تُنشأ أصلًا)
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed — لا جلسات لتخصيصها في نمط stateless" }, id: null },
    { status: 405, headers: { Allow: "POST, DELETE, OPTIONS", ...corsHeaders() } }
  );
}

export async function POST(req: NextRequest) { return handlePost(req); }
export async function GET() { return handleGet(); }
export async function DELETE() { return handleDelete(); }
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
