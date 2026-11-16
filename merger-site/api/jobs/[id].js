// GET /api/jobs/{id} — الحالة + التقدم (0–100) + الرابط عند الاكتمال
// DELETE /api/jobs/{id} — حذف فوري شامل لكل صفوف المهمة
const { setCors, json, fail, noContent, methodNotAllowed, baseUrlFromReq } = require("../../lib/http");
const { getJob, deleteJobRows } = require("../../lib/db");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "GET" && req.method !== "DELETE") return methodNotAllowed(res, ["GET", "DELETE"]);

  const jobId = req.query.id;
  if (!jobId) return fail(res, 400, "معرف المهمة مطلوب");

  try {
    const job = await getJob(jobId);
    if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو لم تُنشأ)");

    if (req.method === "DELETE") {
      await deleteJobRows(jobId);
      return json(res, 200, { ok: true, deleted: jobId });
    }

    const base = baseUrlFromReq(req);
    const payload = {
      jobId: job.id,
      status: job.status,
      progress: Math.max(0, Math.min(100, Math.round(job.progress))),
      expiresAt: job.expiresAt,
    };
    if (job.status === "done") {
      payload.videoUrl = `${base}/api/jobs/${jobId}/video`;
      payload.downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
      payload.size = job.videoSize;
      payload.duration = job.videoDuration;
      payload.resolution = job.videoResolution;
    }
    if (job.status === "failed") payload.error = job.error;
    return json(res, 200, payload);
  } catch (e) {
    return fail(res, 500, e.message || "خطأ غير متوقع");
  }
};
