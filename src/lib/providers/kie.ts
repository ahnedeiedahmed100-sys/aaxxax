// مزود kie.ai — Jobs API الموحد (المزود الأساسي):
// POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId= → data.state: waiting|queuing|generating|success|fail
// انتبه: data.resultJson نص JSON يحتاج JSON.parse ثانيًا — وإذا تغيّر الشكل نتبع توثيق docs.kie.ai الرسمي.
import { fetchWithTimeout, providerError, extractErrorMessage, type ProviderAdapter, type CheckTaskResult } from "./types";

// قراءة كسولة للعنوان — يسمح بتجاوزه للاختبار المحلي (KIE_API_BASE) ويصطف الافتراضي الحقيقي
function kieBase(): string {
  return (process.env.KIE_API_BASE || "https://api.kie.ai/api/v1/jobs").replace(/\/$/, "");
}

interface KieCreateResponse { code?: number; msg?: string; data?: { taskId?: string }; }
interface KieRecordResponse {
  code?: number;
  msg?: string;
  data?: {
    state?: string;
    resultJson?: string; // نص JSON داخلي: {"resultUrls":["https://..."]}
    failMsg?: string;
    progress?: number;
  };
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input) {
    const res = await fetchWithTimeout(`${kieBase()}/createTask`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${key.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: providerModel, input }),
    }, 30000);
    let body: KieCreateResponse = {};
    try { body = await res.json(); } catch { /* جسم غير JSON */ }
    if (!res.ok || (body.code !== undefined && body.code !== 200) || !body.data?.taskId) {
      throw providerError(extractErrorMessage(body, res.status), res.status);
    }
    return { providerTaskId: body.data.taskId };
  },

  async checkTask(key, providerTaskId): Promise<CheckTaskResult> {
    const res = await fetchWithTimeout(`${kieBase()}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${key.apiKey}` },
    }, 20000);
    let body: KieRecordResponse = {};
    try { body = await res.json(); } catch { /* جسم غير JSON */ }
    if (!res.ok || (body.code !== undefined && body.code !== 200)) {
      throw providerError(extractErrorMessage(body, res.status), res.status);
    }
    const d = body.data || {};
    const state = (d.state || "").toLowerCase();
    // waiting | queuing | generating → processing | success → completed | fail → failed
    if (state === "success") {
      let urls: string[] = [];
      if (d.resultJson) {
        try {
          // resultJson نص يحتاج JSON.parse ثانيًا
          const inner = JSON.parse(d.resultJson) as { resultUrls?: string[]; resultUrl?: string };
          urls = inner.resultUrls || (inner.resultUrl ? [inner.resultUrl] : []);
        } catch { /* شكل غير متوقع — نتبع التوثيق وقتها */ }
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: d.failMsg || "أعلن المزود فشل المهمة" };
    }
    // التقدم غير المعلن من المزود — يقدَّر زمنيًا في منسق التوليد
    return { status: "processing", progress: d.progress };
  },
};
