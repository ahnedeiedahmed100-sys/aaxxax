// POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن): سحب → فحص → ترميز → حفظ.
// نجاح 200 → {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
// قيد المعالجة فعله → 202. فشل → 500 + {"error":"..."}
const { setCors, json, fail, noContent, methodNotAllowed, baseUrlFromReq } = require("../../../lib/http");
const { getJob, cleanupExpired } = require("../../../lib/db");
const { runMergeJob, mergeInFlight } = require("../../../lib/mergeRunner");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const jobId = req.query.id;
  if (!jobId) return fail(res, 400, "معرف المهمة مطلوب");

  try {
    await cleanupExpired();
    const job = await getJob(jobId);
    if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    // مكتملة: نعيد النتيجة المخزنة (سلوك تعاودي آمن عند إعادة التشغيل)
    if (job.status === "done") {
      const base = baseUrlFromReq(req);
      return json(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: job.videoSize,
        duration: job.videoDuration,
        resolution: job.videoResolution,
        expiresAt: job.expiresAt,
      });
    }

    // قيد المعالجة بالفعل (قفل داخل الذاكرة يمنع التزامن)
    if (job.status === "processing" || mergeInFlight.has(jobId)) {
      return json(res, 202, { status: "processing", progress: job.progress });
    }

    // فشلت سابقًا: الفشل حتمي حسب قواعد الخدمة — نعيد نفس الخطأ
    if (job.status === "failed") {
      return fail(res, 500, job.error || "فشلت المهمة سابقًا");
    }

    // queued/uploading → تنفيذ الدمج المتزامن (يستغرق عادة 10–60 ثانية)
    const result = await runMergeJob(jobId);
    const updated = await getJob(jobId);
    const base = baseUrlFromReq(req);
    return json(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${jobId}/video`,
      downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: updated.expiresAt,
    });
  } catch (e) {
    const code = e.code && e.code !== 202 ? e.code : 500;
    if (e.code === 202) return json(res, 202, { status: "processing" });
    return fail(res, code, e.message || "فشل تنفيذ الدمج");
  }
};
