// طبقة التخزين — كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف.
const { Readable } = require("node:stream");
const { getDb, ensureSchema } = require("./db");
const { BLOB_ROW_BYTES, READ_PAGE_ROWS } = require("./limits");

// كتابة Buffer كامل إلى جدول أجزاء عبر تقسيمه إلى صفوف 2MB
async function writeBlob(table, keyCols, keyArgs, data) {
  const db = getDb();
  await ensureSchema();
  const rows = [];
  let index = 0;
  for (let offset = 0; offset < data.length; offset += BLOB_ROW_BYTES) {
    const slice = data.subarray(offset, Math.min(offset + BLOB_ROW_BYTES, data.length));
    rows.push({ sql: `INSERT INTO ${table} (${keyCols.join(", ")}, chunk_index, data) VALUES (${keyArgs.map(() => "?").join(", ")}, ?, ?)`, args: [...keyArgs, index, slice] });
    index++;
  }
  // ملف صفر الأحجام (نظريًا لا يحدث) نتجاهله
  if (rows.length) await db.batch(rows, "write");
  return rows.length;
}

// إلحاق جزء مرفوع (≤4MB) مع تقسيمه إلى صفوف 2MB وتحديث عدّاد المصدر — يُعيد عدد الصفوف المضافة
async function appendSourceChunk(jobId, seq, chunkIndex, buf) {
  const db = getDb();
  await ensureSchema();
  const rows = [];
  let offset = 0;
  let rowsAdded = 0;
  while (offset < buf.length) {
    const slice = buf.subarray(offset, Math.min(offset + BLOB_ROW_BYTES, buf.length));
    rows.push({ sql: "INSERT INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)", args: [jobId, seq, chunkIndex * 1000 + rowsAdded, slice] });
    rowsAdded++;
    offset += BLOB_ROW_BYTES;
  }
  if (rows.length) {
    await db.batch(rows, "write");
    // تحديث عدّاد الصفوف المرفوعة للمصدر — يُبقي الثابت «الأجزاء المخزنة = العدّاد» في طبقة واحدة
    const cnt = await db.execute({ sql: "SELECT COUNT(*) AS total FROM source_chunks WHERE job_id = ? AND seq = ?", args: [jobId, seq] });
    await db.execute({ sql: "UPDATE sources SET uploaded_chunks = ? WHERE job_id = ? AND seq = ?", args: [Number(cnt.rows[0].total), jobId, seq] });
  }
  return rowsAdded;
}

// تجميع ملف مصدر مرفوع من صفوف source_chunks بالترتيب
async function assembleSourceChunks(jobId, seq) {
  const db = getDb();
  await ensureSchema();
  const parts = [];
  let offset = 0;
  while (true) {
    const r = await db.execute({
      sql: "SELECT chunk_index, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk_index ASC LIMIT ? OFFSET ?",
      args: [jobId, seq, READ_PAGE_ROWS, offset],
    });
    for (const row of r.rows) parts.push(Buffer.from(row.data));
    if (r.rows.length < READ_PAGE_ROWS) break;
    offset += READ_PAGE_ROWS;
  }
  return Buffer.concat(parts);
}

// تدفق تدريجي لصفوف Blob مع تقليم أول/آخر جزء حسب المدى المطلوب (Range)
// table: "output_chunks" | "source_chunks" — يقرأ صفحات من 8 صفوف ويبث كل صف فور جلبه
async function* rangedBlobRows(table, whereCols, whereArgs, start, end) {
  const db = getDb();
  await ensureSchema();
  const where = whereCols.map((c) => `${c} = ?`).join(" AND ");
  let pos = 0;
  let pageOffset = 0;
  while (true) {
    const r = await db.execute({
      sql: `SELECT chunk_index, data FROM ${table} WHERE ${where} ORDER BY chunk_index ASC LIMIT ? OFFSET ?`,
      args: [...whereArgs, READ_PAGE_ROWS, pageOffset],
    });
    if (r.rows.length === 0) break;
    for (const row of r.rows) {
      const data = Buffer.from(row.data);
      const rowStart = pos;
      const rowEnd = pos + data.length - 1;
      pos += data.length;
      if (rowEnd < start) continue;      // الصف كله قبل المدى
      if (rowStart > end) return;        // تجاوزنا المدى
      const from = Math.max(0, start - rowStart);
      const to = Math.min(data.length - 1, end - rowStart);
      if (to >= from) yield data.subarray(from, to + 1);
      if (rowEnd >= end) return;         // اكتمل المدى المطلوب
    }
    pageOffset += READ_PAGE_ROWS;
  }
}

// قراءة Blob كامل (للاختبارات والتحقق من التطابق) وإرجاع Buffer + sha256
const crypto = require("node:crypto");
async function readBlobAll(table, whereCols, whereArgs) {
  const it = rangedBlobRows(table, whereCols, whereArgs, 0, Number.MAX_SAFE_INTEGER);
  const chunks = [];
  for await (const c of it) chunks.push(c);
  const buf = Buffer.concat(chunks);
  return { buf, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}

// حجم Blob الكامل عبر مجموع أطوال الصفوف
async function blobSize(table, whereCols, whereArgs) {
  const db = getDb();
  await ensureSchema();
  const where = whereCols.map((c) => `${c} = ?`).join(" AND ");
  const r = await db.execute({ sql: `SELECT COALESCE(SUM(length(data)), 0) AS total FROM ${table} WHERE ${where}`, args: whereArgs });
  return Number(r.rows[0].total || 0);
}

// حذف أجزاء مصادر مهمة بعد نجاح الدمج — الناتج فقط هو المطلوب
async function deleteSourceChunks(jobId) {
  const db = getDb();
  await db.execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

module.exports = {
  writeBlob, appendSourceChunk, assembleSourceChunks,
  rangedBlobRows, readBlobAll, blobSize, deleteSourceChunks,
};
