// منسق التوليد — runGeneration + refreshTask: قلب التبديل التسلسلي «لا توقف أبدًا».
// القواعد الذهبية المطبقة هنا:
//  1) تسجيل المهمة في Turso قبل أي نداء خارجي.
//  2) تجربة المفاتيح بالترتيب التسلسلي الصارم حتى نجاح الإنشاء، وكل محاولة تُسجَّل في attempts_json.
//  3) فشل منتصف المهمة بسبب مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
//  4) فشل كل المفاتيح → المهمة تبقى processing «بانتظار توفر مفتاح صالح…» وتُعاد محاولتها مع كل get_task (تهدئة 45 ثانية).
//  5) نموذج الذكاء الاصطناعي لا يرى أخطاء مفاتيح/رصيد أبدًا.
import { randomUUID } from "node:crypto";
import { getKeyPool, bumpKeyStats, classifyProviderError, classAction, type ApiKey } from "./keys";
import { normalizeModelName, type ModelDef, type MediaType } from "./models";
import { insertTask, getTask, updateTask, type Task, type TaskAttempt } from "./tasks";
import { providerError, type ProviderAdapter, type ProviderKey } from "./providers/types";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";

const adapters: Record<string, ProviderAdapter> = { kie: kieAdapter, cometapi: cometapiAdapter };

// تهدئة إعادة المحاولة بعد فشل كل المفاتيح — حتى لا نضغط المزودين مع كل get_task
const RETRY_COOLDOWN_MS = 45_000;
// أنماط فشل مفتاح/رصيد في منتصف المهمة (تستحق إعادة الإنشاء على مفتاح آخر)
const MIDTASK_KEY_FAIL = /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|exhausted|充值/i;

export interface ProgressCb {
  (progress: number, message: string): Promise<void> | void;
}

function toProviderKey(k: ApiKey): ProviderKey {
  return { id: k.id, label: k.label, apiKey: k.apiKey };
}

// بناء مدخلات المزود من معطيات الأداة — أسماء حقول كما في مخططات الأدوات
function buildProviderInput(type: MediaType, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: args.prompt };
  const add = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") input[k] = v; };
  if (type === "image") {
    add("aspect_ratio", args.aspect_ratio);
    add("resolution", args.resolution);
    add("background", args.background);
    add("output_format", args.output_format);
  } else if (type === "video") {
    add("image_url", args.image_url);
    add("aspect_ratio", args.aspect_ratio);
    add("resolution", args.resolution);
    add("enable_audio", args.enable_audio);
    add("duration", args.duration);
  }
  return input;
}

export type GenerationOutcome =
  | { kind: "completed"; task: Task }
  | { kind: "processing"; task: Task } // انتهت النافذة أو انتظر مفتاحًا — يتابع العميل بـ get_task
  | { kind: "params_error"; message: string }; // خطأ معطيات لا يصلحه تبديل المفاتيح

// إنشاء مهمة توليد + محاولة الإنشاء على كل مفاتيح الموديل بالترتيب + نافذة انتظار مع بث تقدم
export async function runGeneration(opts: {
  type: MediaType;
  args: Record<string, unknown>;
  waitSeconds?: number;
  onProgress?: ProgressCb;
  signal?: AbortSignal;
}): Promise<GenerationOutcome> {
  const model = normalizeModelName(String(opts.args.model || (opts.type === "image" ? "gpt-image-2-6/flare-text-to-image" : "grok-imagine-video-1-5-preview")));
  if (!model || model.type !== opts.type) {
    return { kind: "params_error", message: `❌ اسم الموديل غير معروف: ${String(opts.args.model)} — الموديلان المدمجان: gpt-image-2-6/flare-text-to-image و grok-imagine-video-1-5-preview` };
  }

  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    return { kind: "params_error", message: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.` };
  }

  const taskId = randomUUID();
  const waitSeconds = clampInt(opts.waitSeconds, 0, 240, opts.type === "image" ? 90 : 25);
  const input = buildProviderInput(opts.type, opts.args);

  // سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  let task = await insertTask({
    id: taskId,
    model: model.canonical,
    type: opts.type,
    prompt: String(opts.args.prompt || ""),
    params: { ...opts.args, providerInput: input, waitSeconds },
    status: "pending",
  });

  // جرّب المرشحين بالترتيب حتى نجاح الإنشاء (قسم 4.3.1)
  const createResult = await createOnPool(task, model, input, pool);
  task = createResult.task;
  if (createResult.paramsError) {
    // خطأ معطيات: توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
    task = (await updateTask(task.id, { status: "failed", errorMessage: createResult.paramsError }))!;
    return { kind: "params_error", message: `❌ فشلت المهمة: ${createResult.paramsError}` };
  }
  if (!createResult.started) {
    // فشل على كل المفاتيح → تبقى processing «بانتظار توفر مفتاح صالح…» (رسالة داخلية لا تخرج للعميل كفشل)
    task = (await updateTask(task.id, { status: "processing", errorMessage: "بانتظار توفر مفتاح صالح…" }))!;
    return { kind: "processing", task };
  }

  // صورة متزامنة اكتملت فور الإنشاء (مثل CometAPI images) → اكتملت بالفعل خلال النداء نفسه
  if (task.resultUrls?.length) {
    task = (await updateTask(task.id, { status: "completed", progress: 100 }))!;
    await opts.onProgress?.(100, "اكتمل التوليد!");
    return { kind: "completed", task };
  }

  // نافذة الانتظار: استعلم المزود كل 3 ثوانٍ مع بث تقدم
  const outcome = await waitWindow(task, model, waitSeconds, opts.onProgress, opts.signal, createResult.activeKeyIds);
  task = outcome.task;
  if (outcome.completed) return { kind: "completed", task };

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing والعميل يتابع بـ get_task
  return { kind: "processing", task };
}

interface CreateResult {
  task: Task;
  started: boolean;
  paramsError?: string;
  activeKeyIds: string[];
}

// المحاولة على مجمّع المفاتيح بالترتيب — تُستخدم أيضًا من refreshTask لإعادة المحاولة
async function createOnPool(task: Task, model: ModelDef, input: Record<string, unknown>, pool: ApiKey[]): Promise<CreateResult> {
  let t = task;
  const activeKeyIds: string[] = [];
  for (const key of pool) {
    const providerId = model.providers.includes(key.provider as never) ? key.provider : model.providers[0];
    const adapter = adapters[providerId];
    const attemptBase = { provider: providerId, keyId: key.id, keyLabel: key.label };
    try {
      let providerTaskId: string;
      let urls: string[] | undefined;
      // صور متزامنة إن دعمها المزود (CometAPI تعيد النتيجة فورًا)
      if (t.type === "image" && adapter.createImageSync) {
        const sync = await adapter.createImageSync(toProviderKey(key), model.providerModel[providerId], input);
        urls = sync.urls;
        providerTaskId = "sync";
      } else {
        const created = await adapter.createTask(toProviderKey(key), model.providerModel[providerId], input);
        providerTaskId = created.providerTaskId;
      }
      await bumpKeyStats(key.id, { ok: true });
      activeKeyIds.push(key.id);
      const attempt: TaskAttempt = { ...attemptBase, ok: true, at: new Date().toISOString() };
      t = (await updateTask(t.id, {
        provider: providerId as "kie" | "cometapi",
        providerTaskId,
        keyId: key.id,
        status: "processing",
        progress: urls ? 100 : Math.max(t.progress, 5),
        resultUrls: urls || t.resultUrls,
        newAttempt: attempt,
      }))!;
      if (urls) return { task: t, started: true, activeKeyIds };
      // أنشئت المهمة لدى المزود — بدأ العمل الفعلي
      return { task: t, started: true, activeKeyIds };
    } catch (e) {
      const err = e as Error & { status?: number };
      const cls = classifyProviderError(err.status, err.message);
      const action = classAction(cls);
      await bumpKeyStats(key.id, { ok: false, error: err.message, status: action.markStatus });
      const attempt: TaskAttempt = { ...attemptBase, ok: false, errorClass: cls, error: err.message, at: new Date().toISOString() };
      t = (await updateTask(t.id, { newAttempt: attempt }))!;
      if (action.stop) {
        // params: خطأ معطيات — توقف فورًا برسالة عربية واضحة (بلا ذكر مفاتيح)
        return { task: t, started: false, paramsError: err.message, activeKeyIds };
      }
      // انتقل للمفتاح التالي صامتة تمامًا من وجهة نظر العميل
      continue;
    }
  }
  return { task: t, started: false, activeKeyIds };
}

// نافذة الانتظار مع بث التقدم كل 3 ثوانٍ — تتعامل أيضًا مع فشل منتصف المهمة بالتبديل التلقائي
async function waitWindow(
  task: Task,
  model: ModelDef,
  waitSeconds: number,
  onProgress?: ProgressCb,
  signal?: AbortSignal,
  activeKeyIds: string[] = [],
): Promise<{ task: Task; completed: boolean }> {
  let t = task;
  const deadline = Date.now() + waitSeconds * 1000;
  // التقدم الزمني التقديري عندما لا يعلن المزود رقمًا (الصور ~40 ثانية، الفيديو ~120)
  const expectedMs = t.type === "image" ? 40_000 : 120_000;
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    if (signal?.aborted) return { task: t, completed: false };
    await sleep(3000);
    if (!t.providerTaskId || t.providerTaskId === "sync") continue;

    const key = await findKey(t.keyId);
    if (!key) return { task: t, completed: false };
    const adapter = adapters[t.provider || "kie"];
    try {
      const check = await adapter.checkTask(toProviderKey(key), t.providerTaskId);
      if (check.status === "completed" && (check.urls?.length || t.resultUrls?.length)) {
        await bumpKeyStats(key.id, { ok: true });
        const urls = check.urls?.length ? check.urls : t.resultUrls || [];
        t = (await updateTask(t.id, { status: "completed", progress: 100, resultUrls: urls }))!;
        await onProgress?.(100, "اكتمل التوليد!");
        return { task: t, completed: true };
      }
      if (check.status === "failed") {
        // فشل منتصف المهمة: إن كانت رسالة المزود تطابق نمط مشكلات مفتاح/رصيد → أعد الإنشاء بنفس task_id على المفتاح التالي
        if (MIDTASK_KEY_FAIL.test(check.error || "")) {
          await bumpKeyStats(key.id, { ok: false, error: check.error });
          const recreated = await recreateOnNextKey(t, model);
          if (!recreated.ok) {
            // لا مفتاح متبقٍ → تبقى processing بانتظار مفتاح صالح
            t = (await updateTask(t.id, { status: "processing", errorMessage: "بانتظار توفر مفتاح صالح…" }))!;
            return { task: t, completed: false };
          }
          t = recreated.task;
          if (recreated.completed) {
            t = (await updateTask(t.id, { status: "completed", progress: 100 }))!;
            await onProgress?.(100, "اكتمل التوليد!");
            return { task: t, completed: true };
          }
          continue;
        }
        // فشل حقيقي (انتهاك سياسة/معطيات) → failed نهائي
        await bumpKeyStats(key.id, { ok: false, error: check.error });
        t = (await updateTask(t.id, { status: "failed", errorMessage: check.error || "أعلن المزود فشل المهمة" }))!;
        return { task: t, completed: true }; // انتهت برسالة فشل نعرضها للعميل
      }
      // قيد المعالجة: مزيج التقدم المعلن والتقدير الزمني
      const elapsedPct = Math.min(95, Math.round(((Date.now() - startedAt) / expectedMs) * 100));
      const pct = check.progress != null && check.progress > 0 ? Math.max(elapsedPct, Math.min(95, check.progress)) : elapsedPct;
      t = (await updateTask(t.id, { status: "processing", progress: pct }))!;
      await onProgress?.(pct, `قيد التوليد… ${pct}%`);
    } catch (e) {
      // خطأ استعلام مؤقت (شبكة/timeout/429) → استمر بالنافذة، المفتاح يبقى سليمًا
      const err = e as Error & { status?: number };
      const cls = classifyProviderError(err.status, err.message);
      if (cls === "temporary" || cls === "provider") continue;
      // أي شيء آخر نعتبره فشل مفتاح → جرّب التبديل
      const recreated = await recreateOnNextKey(t, model);
      if (!recreated.ok) return { task: t, completed: false };
      t = recreated.task;
      if (recreated.completed) return { task: t, completed: true };
      continue;
    }
  }
  return { task: t, completed: false };
}

// إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي الصالح (قسم 4.3.2)
async function recreateOnNextKey(task: Task, model: ModelDef): Promise<{ ok: boolean; task: Task; completed: boolean }> {
  const pool = await getKeyPool(model.providers);
  // نستبعد المفتاح الذي فشل الآن فقط، والبقية تُجرَّب بالترتيب نفسه
  const remaining = pool.filter((k) => k.id !== task.keyId);
  if (!remaining.length) return { ok: false, task, completed: false };
  const input = (task.params.providerInput as Record<string, unknown>) || {};
  const res = await createOnPool(task, model, input, remaining);
  return { ok: res.started, task: res.task, completed: !!res.task.resultUrls?.length };
}

async function findKey(keyId: string | null): Promise<ApiKey | null> {
  if (!keyId) return null;
  const { getDb, ensureSchema } = await import("./turso");
  await ensureSchema();
  const res = getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [keyId] });
  const rows = (await res).rows;
  if (!rows.length) return null;
  const r = rows[0] as unknown as Record<string, unknown>;
  return {
    id: r.id as string, provider: r.provider as "kie" | "cometapi", label: (r.label as string) || "",
    apiKey: r.api_key as string, status: "active", usageCount: 0, successCount: 0, failCount: 0,
    lastUsedAt: null, lastCheckedAt: null, lastError: null, createdAt: "",
  };
}

// refreshTask — يُستدعى من get_task: تحديث حي للمهمة الجارية من المزود/خدمة الدمج مع نفس منطق التبديل
export async function refreshTask(task: Task): Promise<Task> {
  if (task.status === "completed" || task.status === "failed") return task;

  // مهمة بلا مزود بعد (بانتظار مفتاح صالح) → أعد المحاولة على المجمّع بعد التهدئة
  if (!task.providerTaskId) {
    const since = Date.parse(task.updatedAt.replace(" ", "T") + "Z") || Date.parse(task.updatedAt);
    if (Date.now() - since < RETRY_COOLDOWN_MS) return task;
    const model = normalizeModelName(task.model);
    if (!model) return task;
    const pool = await getKeyPool(model.providers);
    if (!pool.length) return task;
    const input = (task.params.providerInput as Record<string, unknown>) || buildProviderInput(task.type, task.params);
    const res = await createOnPool(task, model, input, pool);
    if (!res.started) return (await updateTask(task.id, { status: "processing", errorMessage: "بانتظار توفر مفتاح صالح…" }))!;
    if (res.task.resultUrls?.length) return (await updateTask(task.id, { status: "completed", progress: 100 }))!;
    return res.task;
  }

  if (task.providerTaskId === "sync") {
    // مهمة صور متزامنة بلا مزود فعلي — لا شيء نستعلمه
    return task;
  }

  const model = normalizeModelName(task.model);
  const key = await findKey(task.keyId);
  if (!model || !key) return task;
  const adapter = adapters[task.provider || "kie"];

  try {
    const check = await adapter.checkTask(toProviderKey(key), task.providerTaskId);
    if (check.status === "completed") {
      const urls = check.urls?.length ? check.urls : task.resultUrls || [];
      return (await updateTask(task.id, { status: "completed", progress: 100, resultUrls: urls }))!;
    }
    if (check.status === "failed") {
      if (MIDTASK_KEY_FAIL.test(check.error || "")) {
        const recreated = await recreateOnNextKey(task, model);
        if (!recreated.ok) return (await updateTask(task.id, { status: "processing", errorMessage: "بانتظار توفر مفتاح صالح…" }))!;
        if (recreated.task.resultUrls?.length) return (await updateTask(task.id, { status: "completed", progress: 100 }))!;
        return recreated.task;
      }
      return (await updateTask(task.id, { status: "failed", errorMessage: check.error || "أعلن المزود فشل المهمة" }))!;
    }
    const pct = check.progress != null && check.progress > 0 ? Math.min(95, check.progress) : task.progress;
    return (await updateTask(task.id, { status: "processing", progress: pct }))!;
  } catch (e) {
    const err = e as Error & { status?: number };
    const cls = classifyProviderError(err.status, err.message);
    if (cls === "disabled" || cls === "exhausted") {
      await bumpKeyStats(key.id, { ok: false, error: err.message, status: classAction(cls).markStatus });
      const recreated = await recreateOnNextKey(task, model);
      if (!recreated.ok) return (await updateTask(task.id, { status: "processing", errorMessage: "بانتظار توفر مفتاح صالح…" }))!;
      if (recreated.task.resultUrls?.length) return (await updateTask(task.id, { status: "completed", progress: 100 }))!;
      return recreated.task;
    }
    // temporary/provider: استمر بالاستعلام في مرة قادمة
    return task;
  }
}

export { providerError };

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v));
  if (Number.isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
