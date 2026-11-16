// عميل خدمة دمج الفيديو — Video Merger API v2 (بلا مفاتيح أو توثيق).
// العنوان من MERGER_API_BASE. المخرجات: MP4 (H.264 + AAC) حتى 1080p — بلا معاملات resolution/fps.
// تحليل الحالة دفاعي: أخطاء بلا status = failed، progress كسر 0..1 يُضرب في 100.
import { fetchWithTimeout, providerError } from "./providers/types";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "http://localhost:3001").replace(/\/$/, "");

export interface MergerJob {
  jobId: string;
  status: "queued" | "uploading" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
  error?: string;
}

const DONE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED = /^(error|failed|failure|cancelled)$/i;

export async function mergerConfig(): Promise<{ healthy: boolean; base: string }> {
  try {
    const res = await fetchWithTimeout(`${MERGER_BASE}/api/config`, { method: "GET" }, 4000);
    return { healthy: res.ok, base: MERGER_BASE };
  } catch {
    return { healthy: false, base: MERGER_BASE };
  }
}

// POST /api/jobs {"videos":[...]} → {jobId, status, statusUrl, processUrl, expiresAt}
export async function mergerCreateJob(urls: string[]): Promise<{ jobId: string; expiresAt?: string }> {
  const res = await fetchWithTimeout(`${MERGER_BASE}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  }, 15000);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.jobId) {
    throw providerError(body.error || `فشل إنشاء مهمة الدمج (HTTP ${res.status})`, res.status);
  }
  return { jobId: body.jobId, expiresAt: body.expiresAt };
}

// POST /api/jobs/{id}/process — متزامن ~10–60 ثانية
export async function mergerProcess(jobId: string): Promise<{ done: boolean; job?: MergerJob }> {
  const res = await fetchWithTimeout(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 300000);
  if (res.status === 202) return { done: false };
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw providerError(body.error || `فشل تنفيذ الدمج (HTTP ${res.status})`, res.status);
  return { done: body.status === "done", job: normalizeMergerBody(body, jobId) };
}

// GET /api/jobs/{id} — تحليل دفاعي للحالة
export async function mergerStatus(jobId: string): Promise<MergerJob> {
  const res = await fetchWithTimeout(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 15000);
  const body = await res.json().catch(() => ({}));
  // انتبه: قد يرد الجسم فيه error بدون حقل status → نعاملها failed فورًا
  if (res.status === 404) {
    return { jobId, status: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  return normalizeMergerBody(body, jobId);
}

export async function mergerDelete(jobId: string): Promise<void> {
  await fetchWithTimeout(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }, 10000).catch(() => { /* التنظيف اختياري */ });
}

function normalizeMergerBody(body: Record<string, unknown>, jobId: string): MergerJob {
  let rawStatus = String(body.status || "");
  const hasError = typeof body.error === "string" && body.error.length > 0;
  if (!rawStatus && hasError) rawStatus = "failed";
  if (hasError && FAILED.test(rawStatus)) rawStatus = "failed";

  let status: MergerJob["status"] = "processing";
  if (DONE.test(rawStatus)) status = "done";
  else if (FAILED.test(rawStatus)) status = "failed";
  else if (queuedish(rawStatus)) status = "processing"; // queued/uploading معناها لم يبدأ التنفيذ بعد

  // progress أحيانًا يأتي كسرًا 0..1 → نضربه في 100
  let progress = Number(body.progress || 0);
  if (progress > 0 && progress < 1) progress = progress * 100;
  progress = Math.max(0, Math.min(100, Math.round(progress)));

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط الرابط الصياغي من jobId
  const videoUrl = (body.videoUrl as string) || (body.downloadUrl as string) || (status === "done" ? `${MERGER_BASE}/api/jobs/${jobId}/video` : undefined);
  return {
    jobId: String(body.jobId || jobId),
    status,
    progress,
    videoUrl,
    downloadUrl: (body.downloadUrl as string) || (videoUrl ? `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1` : undefined),
    size: body.size != null ? Number(body.size) : undefined,
    duration: body.duration != null ? Number(body.duration) : undefined,
    resolution: (body.resolution as string) || undefined,
    expiresAt: (body.expiresAt as string) || undefined,
    error: hasError ? String(body.error) : undefined,
  };
}

function queuedish(s: string): boolean {
  return /^(queued|uploading|processing|pending|running)$/i.test(s) || s === "";
}

export { providerError };
