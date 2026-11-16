// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP للتوافق مع Vercel (لا ملفات SQLite محلية في الإنتاج).
// إن لم تضبط TURSO_DATABASE_URL نستخدم ملفًا محليًا للتطوير فقط مع تحذير صريح.
import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    // تطوير محلي فقط — على Vercel أضف TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في Settings → Environment Variables
    console.warn("[turso] TURSO_DATABASE_URL غير مضبوط — استخدام ملف محلي للتطوير فقط");
    const dir = path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    client = createClient({ url: `file:${dir}/mcp.db` });
  } else {
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  }
  return client;
}

// إنشاء الجداول عند أول وصول — لا حاجة لأداة migrations
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
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
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
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
    })().catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// هل المهيأ رابط Turso حقيقي؟ (للتمييز في /api/health بين الاتصال الفعلي ووضع التطوير المحلي)
export function isTursoConfigured(): boolean {
  return !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_DATABASE_URL.trim());
}
