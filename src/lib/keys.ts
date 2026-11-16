// نظام المفاتيح المتسلسلة — قلب المشروع:
// ترتيب تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin وليس «الأقل استخدامًا أولًا».
// المفتاح المستنزف يبقى في القاعدة والقائمة (يُعاد تجريبه إذا شُحن رصيده)، والتعطيل اليدوي فقط يخرجه.
import { randomUUID } from "node:crypto";
import { getDb, ensureSchema } from "./turso";
import type { ProviderId } from "./models";

export type KeyStatus = "active" | "exhausted" | "disabled";
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface ApiKey {
  id: string;
  provider: ProviderId;
  label: string;
  apiKey: string;
  status: KeyStatus;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface KeyRow { [k: string]: unknown }

function rowToKey(r: KeyRow): ApiKey {
  return {
    id: r.id as string,
    provider: r.provider as ProviderId,
    label: (r.label as string) || "",
    apiKey: r.api_key as string,
    status: (r.status as KeyStatus) || "active",
    usageCount: Number(r.usage_count || 0),
    successCount: Number(r.success_count || 0),
    failCount: Number(r.fail_count || 0),
    lastUsedAt: (r.last_used_at as string) || null,
    lastCheckedAt: (r.last_checked_at as string) || null,
    lastError: (r.last_error as string) || null,
    createdAt: r.created_at as string,
  };
}

// إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 3)}••••`;
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

// جلب المفاتيح غير المعطلة لهذه المزودات بالترتيب التسلسلي الصارم
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKey[]> {
  await ensureSchema();
  const db = getDb();
  const placeholders = providers.map(() => "?").join(", ");
  const res = await db.execute({
    sql: `SELECT * FROM api_keys WHERE status != 'disabled' AND provider IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return res.rows.map((r) => rowToKey(r as KeyRow));
}

// القائمة الكاملة مع إخفاء المفاتيح دائمًا — لا يُعاد المفتاح الكامل في أي استجابة
export interface SafeApiKey extends Omit<ApiKey, "apiKey"> { masked: string; }

export async function listKeys(): Promise<SafeApiKey[]> {
  await ensureSchema();
  const db = getDb();
  const res = await db.execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return res.rows.map((r) => {
    const k = rowToKey(r as KeyRow);
    const masked = maskKey(k.apiKey);
    const { apiKey: _hidden, ...safe } = k;
    void _hidden;
    return { ...safe, masked };
  });
}

export async function addKey(provider: ProviderId, apiKey: string, label?: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await ensureSchema();
  const db = getDb();
  // رفض التكرار لنفس المزود
  const dup = await db.execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    args: [provider, apiKey],
  });
  if (dup.rows.length) return { ok: false, error: "هذا المفتاح مضاف مسبقًا لنفس المزود — رفض التكرار" };
  const id = randomUUID();
  // طابع ميلي ثانية صريح — datetime('now') بدقة الثانية فقط، والمفاتيح المضافة في نفس الثانية
  // ستفقد ترتيب الإضافة الصارم عند التعادل (شرط القلب: أول مفتاح أُضيف يُجرَّب أولًا)
  await db.execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
    args: [id, provider, label || "", apiKey, new Date().toISOString()],
  });
  return { ok: true, id };
}

export async function setKeyStatus(id: string, status: KeyStatus): Promise<boolean> {
  await ensureSchema();
  const db = getDb();
  const res = await db.execute({ sql: "UPDATE api_keys SET status = ? WHERE id = ?", args: [status, id] });
  return res.rowsAffected > 0;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const db = getDb();
  const res = await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return res.rowsAffected > 0;
}

// تحديث عدادات المفتاح دائمًا مع كل محاولة (نجاح أو فشل)
export async function bumpKeyStats(id: string, opts: { ok: boolean; error?: string; status?: KeyStatus }): Promise<void> {
  const db = getDb();
  await ensureSchema();
  await db.execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?,
            status = COALESCE(?, status)
          WHERE id = ?`,
    args: [opts.ok ? 1 : 0, opts.ok ? 0 : 1, opts.error || null, opts.status || null, id],
  });
}

// تصنيف موحد لأخطاء المزود — يحدد الإجراء التالي حسب جدول المواصفة.
// ملاحظة: نفحص نفاد الرصيد قبل 400 لأن بعض المزودين يرسلونه بحالة 400.
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(m)) return "disabled";
  if (status === 402 || /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(m)) return "exhausted";
  if (/model not found|unsupported model/.test(m) && (status === 400 || status === 404 || status === 422)) return "provider";
  if (status === 400 || status === 422) return "params";
  // 429 أو 5xx أو انقطاع شبكة/timeout (بلا حالة) = مؤقت
  return "temporary";
}

// الإجراء المقترح لكل فئة: disabled/exhausted → علّم المفتاح وانتقل للتالي؛ provider/temporary → انتقل للتالي؛ params → توقف فورًا
export function classAction(c: ErrorClass): { markStatus?: KeyStatus; next: boolean; stop: boolean } {
  switch (c) {
    case "disabled": return { markStatus: "disabled", next: true, stop: false };
    case "exhausted": return { markStatus: "exhausted", next: true, stop: false };
    case "provider": return { next: true, stop: false };
    case "temporary": return { next: true, stop: false };
    case "params": return { next: false, stop: true };
  }
}
