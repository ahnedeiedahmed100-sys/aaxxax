// مزود CometAPI (المزود الثاني):
// الصور: نقطة متوافقة مع OpenAI تعيد النتيجة فورًا — POST /v1/images/generations → data[0].url
// الفيديو: نقطة مهام غير متزامنة بنفس نمط create/check (حسب توثيق cometapi.com الحالي، مارس 2026):
//   POST /v1/videos/generations {model, prompt, ...} → {request_id | task_id | id}
//   GET  /v1/videos/{id} → {data:{status:"SUCCESS"|..., data:{video:{url}}}} — نحلل بتسامح ونحترم أشكالًا بديلة.
import { fetchWithTimeout, providerError, extractErrorMessage, type ProviderAdapter, type CheckTaskResult } from "./types";

// قراءة كسولة للعنوان — يسمح بتجاوزه للاختبار المحلي (COMETAPI_BASE_URL) ويصطف الافتراضي الحقيقي
function cometBase(): string {
  return (process.env.COMETAPI_BASE_URL || "https://api.cometapi.com").replace(/\/$/, "");
}

interface CometImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  msg?: string;
  error?: unknown;
}
interface CometVideoCreateResponse { request_id?: string; task_id?: string; id?: string; data?: { id?: string }; msg?: string; }
interface CometVideoStatusResponse {
  status?: string; // بعض الأشكال تضع status في الجذر
  data?: { status?: string; data?: { video?: { url?: string }; video_url?: string; url?: string }; video_url?: string; url?: string };
  msg?: string;
}

function authHeaders(key: string): Record<string, string> {
  return { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" };
}

// الحالة الناجحة/الفاشلة بصيغ متعددة محتملة من المزود — تحليل دفاعي
function mapVideoStatus(raw: string | undefined): "processing" | "completed" | "failed" | undefined {
  const s = (raw || "").toUpperCase();
  if (/SUCCESS|COMPLETED|COMPLETE|SUCCEEDED|FINISHED|DONE/.test(s)) return "completed";
  if (/FAIL|ERROR|CANCEL/.test(s)) return "failed";
  if (s) return "processing";
  return undefined;
}

function extractVideoUrl(body: CometVideoStatusResponse): string | undefined {
  return body.data?.data?.video?.url || body.data?.data?.video_url || body.data?.data?.url || body.data?.video_url || body.data?.url;
}

export const cometapiAdapter: ProviderAdapter = {
  // صور متزامنة — تعيد الرابط فورًا (نرفض b64_json وحدنا لأن قاعدة المشروع: روابط فقط بلا تنزيل)
  async createImageSync(key, providerModel, input) {
    const res = await fetchWithTimeout(`${cometBase()}/v1/images/generations`, {
      method: "POST",
      headers: authHeaders(key.apiKey),
      body: JSON.stringify({ model: providerModel, ...input }),
    }, 60000);
    let body: CometImageResponse = {};
    try { body = await res.json(); } catch { /* جسم غير JSON */ }
    if (!res.ok) throw providerError(extractErrorMessage(body, res.status), res.status);
    const item = body.data?.[0];
    if (item?.url) return { urls: [item.url] };
    if (item?.b64_json) {
      throw providerError("المزود أعاد صورة بصيغة b64_json دون رابط — غير مدعوم (الروابط فقط)", res.status);
    }
    throw providerError(extractErrorMessage(body, res.status), res.status);
  },

  async createTask(key, providerModel, input) {
    const res = await fetchWithTimeout(`${cometBase()}/v1/videos/generations`, {
      method: "POST",
      headers: authHeaders(key.apiKey),
      body: JSON.stringify({ model: providerModel, ...input }),
    }, 30000);
    let body: CometVideoCreateResponse = {};
    try { body = await res.json(); } catch { /* جسم غير JSON */ }
    if (!res.ok) throw providerError(extractErrorMessage(body, res.status), res.status);
    const id = body.request_id || body.task_id || body.id || body.data?.id;
    if (!id) throw providerError(extractErrorMessage(body, res.status) || "لم يعد المزود معرّف مهمة", res.status);
    return { providerTaskId: String(id) };
  },

  async checkTask(key, providerTaskId): Promise<CheckTaskResult> {
    const res = await fetchWithTimeout(`${cometBase()}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: authHeaders(key.apiKey),
    }, 20000);
    let body: CometVideoStatusResponse = {};
    try { body = await res.json(); } catch { /* جسم غير JSON */ }
    if (!res.ok) throw providerError(extractErrorMessage(body, res.status), res.status);
    const mapped = mapVideoStatus(body.data?.status || body.status);
    if (mapped === "completed") {
      const url = extractVideoUrl(body);
      if (!url) throw providerError("أعلن المزود الاكتمال دون رابط نتيجة", res.status);
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (mapped === "failed") {
      return { status: "failed", error: extractErrorMessage(body, res.status) };
    }
    return { status: "processing" };
  },
};
