// اختبار سريع: libSQL بنمط ملف محلي + Blob
const { createClient } = require("@libsql/client");
(async () => {
  const c = createClient({ url: "file:/tmp/test-libsql.db" });
  await c.execute("CREATE TABLE IF NOT EXISTS t (id TEXT, b BLOB)");
  await c.execute({ sql: "INSERT OR REPLACE INTO t (id, b) VALUES (?, ?)", args: ["a", new Uint8Array([1,2,3])] });
  const r = await c.execute("SELECT * FROM t");
  console.log("OK rows:", r.rows.length, "blob bytes:", (r.rows[0].b instanceof Uint8Array) ? r.rows[0].b.length : typeof r.rows[0].b);
  await c.close();
})().catch(e => { console.error("FAIL:", e.message); process.exit(1); });
