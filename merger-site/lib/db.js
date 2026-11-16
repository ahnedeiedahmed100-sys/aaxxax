// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP على الإنتاج، أو ملف محلي للتطوير.
// كل شيء يُخزَّن هنا: المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — بلا S3 ولا خدمات خارجية.
const { createClient } = require("@libsql/client");
const { EXPIRY_HOURS } = require("./limits");

let client = null;
let schemaPromise = null;

function getDb() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error("متغير البيئة TURSO_DATABASE_URL مفقود — أضفه في .env محليًا أو في إعدادات Vercel");
  }
  // authToken اختياري فقط لملفات التطوير المحلية؛ على Turso الحقيقي يلزم توكن بكتابة
  client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  });
  return client;
}

// إنشاء الجداول عند أول وصول — لا حاجة لأداة migrations
function ensureSchema() {
  if (!schemaPromise) {
    const db = getDb();
    schemaPromise = (async () => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER NOT NULL DEFAULT 0,
          sources_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          video_size INTEGER,
          video_duration REAL,
          video_resolution TEXT,
          output_chunks INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          mime TEXT,
          size INTEGER NOT NULL DEFAULT 0,
          uploaded_chunks INTEGER NOT NULL DEFAULT 0,
          probe_json TEXT,
          PRIMARY KEY (job_id, seq)
        )`);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk_index)
        )`);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk_index)
        )`);
    })().catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

async function dbHealthy() {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function nowIso() { return new Date().toISOString(); }

// expires_at = وقت الإنشاء + 24 ساعة
function computeExpiry() {
  return new Date(Date.now() + EXPIRY_HOURS * 3600 * 1000).toISOString();
}

async function createJob({ id, sourcesCount, hasFiles }) {
  const db = getDb();
  await ensureSchema();
  await db.execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_count, expires_at, created_at, updated_at)
          VALUES (?, ?, 0, ?, ?, ?, ?)`,
    args: [id, hasFiles ? "uploading" : "queued", sourcesCount, computeExpiry(), nowIso(), nowIso()],
  });
  return getJob(id);
}

async function getJob(id) {
  const db = getDb();
  await ensureSchema();
  const r = await db.execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [id] });
  return r.rows[0] ? rowToJob(r.rows[0]) : null;
}

function rowToJob(row) {
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress || 0),
    sourcesCount: Number(row.sources_count || 0),
    error: row.error || null,
    videoSize: row.video_size != null ? Number(row.video_size) : null,
    videoDuration: row.video_duration != null ? Number(row.video_duration) : null,
    videoResolution: row.video_resolution || null,
    outputChunks: Number(row.output_chunks || 0),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

async function updateJob(id, patch) {
  const db = getDb();
  await ensureSchema();
  const sets = [];
  const args = [];
  const allowed = {
    status: "status", progress: "progress", error: "error",
    videoSize: "video_size", videoDuration: "video_duration",
    videoResolution: "video_resolution", outputChunks: "output_chunks",
  };
  for (const [k, col] of Object.entries(allowed)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); args.push(patch[k]); }
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(id);
  await db.execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function listSources(jobId) {
  const db = getDb();
  await ensureSchema();
  const r = await db.execute({ sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC", args: [jobId] });
  return r.rows.map((row) => ({
    jobId: row.job_id,
    seq: Number(row.seq),
    kind: row.kind,
    url: row.url || null,
    name: row.name || null,
    mime: row.mime || null,
    size: Number(row.size || 0),
    uploadedChunks: Number(row.uploaded_chunks || 0),
  }));
}

async function insertSource(jobId, seq, src) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size, uploaded_chunks)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    args: [jobId, seq, src.kind, src.url || null, src.name || null, src.mime || null, src.size || 0],
  });
}

// توليد معرف مهمة قصير مقروء (12 حرفًا صغيرًا/رقمًا) على نمط الأمثلة المقاسة
function generateJobId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// حذف فوري شامل: صفوف المهمة في الجداول الأربعة دفعة واحدة
async function deleteJobRows(jobId) {
  const db = getDb();
  await ensureSchema();
  await db.batch([
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
  ], "write");
}

// التنظيف الكسول للمهام المنتهية (يُستدعى عند كل إنشاء/دمج + من /api/cron)
async function cleanupExpired() {
  const db = getDb();
  await ensureSchema();
  const now = nowIso();
  const r = await db.execute({ sql: "SELECT id FROM jobs WHERE expires_at <= ?", args: [now] });
  const ids = r.rows.map((x) => x.id);
  for (const id of ids) await deleteJobRows(id);
  return ids.length;
}

module.exports = {
  getDb, ensureSchema, dbHealthy,
  createJob, getJob, updateJob, listSources, insertSource,
  generateJobId, deleteJobRows, cleanupExpired, rowToJob,
};
