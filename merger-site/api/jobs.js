// POST /api/jobs — إنشاء مهمة دمج من روابط مباشرة و/أو ملفات ستُرفع لاحقًا.
// يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
const crypto = require("node:crypto");
const { setCors, json, fail, methodNotAllowed, baseUrlFromReq, readJsonBody } = require("../lib/http");
const { createJob, insertSource, cleanupExpired, generateJobId } = require("../lib/db");
const { MAX_SOURCES, SOURCE_MAX_MB, UPLOAD_CHUNK_BYTES } = require("../lib/limits");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  try {
    await cleanupExpired(); // تنظيف كسول للمهام المنتهية

    const body = await readJsonBody(req);
    // توحيد المدخلات: videos اختصار لمصادر url
    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((url) => ({ kind: "url", url }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => ({
        kind: s.kind === "file" ? "file" : "url",
        url: s.url || null,
        name: s.name || null,
        mime: s.mime || null,
        size: Number(s.size || 0),
      }));
    } else {
      return fail(res, 400, "الجسم يجب أن يحتوي مصفوفة videos أو sources");
    }

    if (sources.length < 2) {
      return fail(res, 400, "الدمج يحتاج مقطعَين على الأقل — مرّر مصفوفة videos بروابط مباشرة");
    }
    if (sources.length > MAX_SOURCES) {
      return fail(res, 400, `أقصى عدد مقاطع للدمج هو ${MAX_SOURCES} (خدمة الدمج تقبل ${MAX_SOURCES} مقاطع كحد أقصى)`);
    }

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (s.kind === "url") {
        // روابط مباشرة عامة فقط — http/https
        if (!s.url || !/^https?:\/\//i.test(s.url)) {
          return fail(res, 400, `المصدر رقم ${i + 1}: الرابط مطلوب ويجب أن يكون http/https مباشرًا وعامًا`);
        }
        try { const u = new URL(s.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { return fail(res, 400, `المصدر رقم ${i + 1}: رابط غير صالح`); }
      } else {
        if (!s.name) return fail(res, 400, `المصدر رقم ${i + 1}: الملفات تحتاج حقل name`);
        if (s.size > SOURCE_MAX_MB * 1024 * 1024) {
          return fail(res, 400, `الملف "${s.name}" يتجاوز الحد المسموح (${SOURCE_MAX_MB}MB لكل مصدر)`);
        }
      }
    }

    const id = generateJobId();
    const hasFiles = sources.some((s) => s.kind === "file");
    const job = await createJob({ id, sourcesCount: sources.length, hasFiles });

    for (let i = 0; i < sources.length; i++) await insertSource(id, i, sources[i]);

    const base = baseUrlFromReq(req);
    const payload = {
      jobId: id,
      status: job.status, // queued | uploading
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
      expiresAt: job.expiresAt,
    };
    if (hasFiles) {
      // روابط الرفع لكل ملف — الرفع أجزاء POST ثنائية ≤4MB مع إعادة محاولة من العميل
      payload.uploads = sources.map((s, i) => ({
        seq: i,
        url: `${base}/api/upload?job=${id}&seq=${i}&chunk=0`,
        kind: s.kind,
        name: s.name,
      }));
      payload.uploadChunkBytes = UPLOAD_CHUNK_BYTES;
    }
    void crypto;
    return json(res, 201, payload);
  } catch (e) {
    const code = e.code || 500;
    return fail(res, code, e.message || "خطأ غير متوقع");
  }
};
