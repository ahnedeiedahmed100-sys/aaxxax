// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB).
// كل جزء يُقسَّم داخليًا إلى صفوف 2MB في جدول source_chunks.
const { setCors, json, fail, methodNotAllowed, readRawBody } = require("../lib/http");
const { getDb, ensureSchema, getJob, updateJob } = require("../lib/db");
const { appendSourceChunk } = require("../lib/storage");
const { UPLOAD_CHUNK_BYTES } = require("../lib/limits");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  try {
    const jobId = req.query.job;
    const seq = parseInt(req.query.seq, 10);
    const chunk = parseInt(req.query.chunk, 10);
    if (!jobId || Number.isNaN(seq) || Number.isNaN(chunk) || seq < 0 || chunk < 0) {
      return fail(res, 400, "معطيات الرفع غير صالحة — يلزم job وseq وchunk");
    }

    const job = await getJob(jobId);
    if (!job) return fail(res, 404, "المهمة غير موجودة");
    if (!["queued", "uploading"].includes(job.status)) {
      return fail(res, 409, `لا يمكن الرفع في حالة المهمة الحالية (${job.status})`);
    }

    const db = getDb();
    await ensureSchema();
    const sr = await db.execute({ sql: "SELECT seq, name, kind FROM sources WHERE job_id = ? AND seq = ?", args: [jobId, seq] });
    if (!sr.rows.length) return fail(res, 404, `لا يوجد مصدر برقم ${seq} في هذه المهمة`);
    if (sr.rows[0].kind !== "file") return fail(res, 400, `المصدر رقم ${seq} رابط مباشر ولا يقبل رفع ملفات`);

    const buf = await readRawBody(req, UPLOAD_CHUNK_BYTES);
    if (!buf.length) return fail(res, 400, "الجسم فارغ — أرسل البيانات الثنائية الخام مباشرة");

    const rowsAdded = await appendSourceChunk(jobId, seq, chunk, buf);

    // تحديث عدّاد الصفوف المرفوعة وحالة المهمة إلى uploading
    const cnt = await db.execute({ sql: "SELECT COUNT(*) AS total FROM source_chunks WHERE job_id = ? AND seq = ?", args: [jobId, seq] });
    const uploadedRows = Number(cnt.rows[0]?.total || 0);
    await db.execute({ sql: "UPDATE sources SET uploaded_chunks = ? WHERE job_id = ? AND seq = ?", args: [uploadedRows, jobId, seq] });
    if (job.status === "queued") await updateJob(jobId, { status: "uploading" });

    return json(res, 200, {
      ok: true,
      job: jobId,
      seq,
      chunk,
      received: buf.length,
      storedRows: rowsAdded,
      uploadedRows,
    });
  } catch (e) {
    const code = e.code || 500;
    return fail(res, code, e.message || "خطأ غير متوقع أثناء الرفع");
  }
};
