// اختبار الاتصال بقاعدة Turso الحقيقية — يقرأ المتغيرات من .env.local تلقائيًا
// التشغيل: node --env-file=.env.local scripts/test-turso.js
const { createClient } = require("@libsql/client");

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;

if (!url || !url.startsWith("libsql://")) {
  console.error("FAIL: TURSO_DATABASE_URL غير مضبوط أو ليس رابط Turso بعيدًا");
  process.exit(1);
}
if (!token) {
  console.error("FAIL: TURSO_AUTH_TOKEN غير مضبوط");
  process.exit(1);
}

console.log("URL:", url);
console.log("Token:", token.slice(0, 12) + "••••••••" + token.slice(-6));

(async () => {
  const db = createClient({ url, authToken: token });

  // 1) فحص الجهوزية
  await db.execute("SELECT 1");
  console.log("✓ الاتصال ناجح (SELECT 1)");

  // 2) إنشاء الجداول — نفس مخطط src/lib/turso.ts و merger-site/lib/db.js
  await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    provider TEXT,
    provider_task_id TEXT,
    key_id TEXT,
    model TEXT NOT NULL,
    type TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    params_json TEXT DEFAULT '{}',
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    result_urls_json TEXT,
    error_message TEXT,
    attempts_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT DEFAULT '',
    api_key TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    usage_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    last_used_at TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS jobs (
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
    expires_at TEXT NOT NULL
  )`);
  console.log("✓ الجداول جاهزة (tasks / api_keys / jobs)");

  // 3) اختبار كتابة وقراءة وحذف فعلي
  const testId = "conn-test-" + Date.now();
  await db.execute({
    sql: "INSERT OR REPLACE INTO tasks (id, model, type, status, prompt) VALUES (?, ?, ?, ?, ?)",
    args: [testId, "test-model", "image", "completed", "اختبار اتصال"],
  });
  const r = await db.execute({ sql: "SELECT id, prompt, status FROM tasks WHERE id = ?", args: [testId] });
  if (r.rows.length !== 1 || r.rows[0].prompt !== "اختبار اتصال") {
    throw new Error("قراءة الصف التجريبي لم تطابق المكتوب");
  }
  console.log("✓ كتابة/قراءة/حذف تعمل — الصف التجريبي:", JSON.stringify(r.rows[0]));
  await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [testId] });
  console.log("✓ الصف التجريبي حُذف — القاعدة نظيفة");

  // 4) عرض حالة الجداول الحالية
  const tables = await db.execute(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const counts = {};
  for (const t of tables.rows) {
    const c = await db.execute({ sql: `SELECT COUNT(*) AS n FROM "${t.name}"`, args: [] });
    counts[t.name] = Number(c.rows[0].n);
  }
  console.log("✓ محتوى القاعدة:", JSON.stringify(counts, null, 2));
  console.log("ALL OK — قاعدة Turso مربوطة وتعمل بكتابة كاملة");
  db.close();
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
