// GET /api/jobs/{id}/video — بث الناتج MP4 بدعم Range (206 + Content-Range) ليعمل التقديم/الترجيع،
// و?download=1 للتحميل المباشر. يقرأ صفوف output_chunks تدفقيًا بصفحات من 8 صفوف مع تقليم المدى.
const { pipeline } = require("node:stream/promises");
const { setCors, fail, noContent, methodNotAllowed } = require("../../../lib/http");
const { getJob } = require("../../../lib/db");
const { rangedBlobRows, blobSize } = require("../../../lib/storage");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET"]);

  const jobId = req.query.id;
  if (!jobId) return fail(res, 400, "معرف المهمة مطلوب");

  try {
    const job = await getJob(jobId);
    if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status !== "done") {
      return fail(res, 409, `الناتج غير متاح بعد — حالة المهمة: ${job.status}`);
    }

    const total = await blobSize("output_chunks", ["job_id"], [jobId]);
    if (!total) return fail(res, 404, "ملف الناتج مفقود من التخزين");

    // تحليل ترويسة Range: bytes=start-end
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = total - 1;
    let partial = false;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (m && (m[1] !== "" || m[2] !== "")) {
        if (m[1] === "" && m[2] !== "") {
          // لاحقة: آخر N بايت
          const n = parseInt(m[2], 10);
          start = Math.max(0, total - n);
        } else {
          start = parseInt(m[1] || "0", 10);
          if (m[2] !== "") end = Math.min(parseInt(m[2], 10), total - 1);
        }
        if (start > end || start >= total) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${total}`);
          return res.end();
        }
        partial = true;
      }
    }

    res.statusCode = partial ? 206 : 200;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(end - start + 1));
    if (partial) res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="merged-${jobId}.mp4"`);
    }

    if (req.method === "HEAD") return res.end();

    const stream = require("node:stream");
    const nodeStream = stream.Readable.from(rangedBlobRows("output_chunks", ["job_id"], [jobId], start, end));
    await pipeline(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) return fail(res, 500, e.message || "خطأ غير متوقع أثناء البث");
    res.end();
  }
};
