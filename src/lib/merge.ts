// تدفق الدمج — runMerge + refreshMergeTask وفق قسم 7.3 من المواصفة:
// 1) تحقق صارم: ≥2 مقاطع، روابط http/https مباشرة عامة، >10 → رفض برسالة عربية.
// 2) تسجيل المهمة type="merge" provider="merger" model="video-merger" في Turso أولًا.
// 3) POST /api/jobs ثم إطلاق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة processInFlight).
// 4) نافذة انتظار (افتراضي 60 ثانية): استعلام كل 3 ثوانٍ مع بث تقدم وكتابة الحالة فورًا كل مرة.
// 5) قاعدة حتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري؛ أخطاء شبكتنا = مؤقتة.
// 6) refreshMergeTask: تحديث من الخدمة، تنفيذ process عند اللزوم، و404 = فشل نهائي.
import { randomUUID } from "node:crypto";
import { insertTask, getTask, updateTask, type Task } from "./tasks";
import { mergerCreateJob, mergerProcess, mergerStatus, MERGER_BASE } from "./merger";
import type { ProgressCb } from "./generation";

// قفل في الذاكرة يمنع تزامن process مع get_task على نفس المهمة (مرة واحدة فقط)
const processInFlight = new Set<string>();

export interface MergeOutcome {
  kind: "completed" | "processing" | "validation_error";
  task?: Task;
  message?: string;
}

// حل روابط task_ids لمهام فيديو مكتملة (بالترتيب) — تُسبق الروابط المباشرة بنفس ترتيبها
async function resolveTaskIds(taskIds: string[] | undefined): Promise<{ urls: string[]; errors: string[] }> {
  const urls: string[] = [];
  const errors: string[] = [];
  if (!taskIds?.length) return { urls, errors };
  for (const tid of taskIds) {
    const t = await getTask(tid.trim());
    if (!t) { errors.push(`المهمة ${tid} غير موجودة في قاعدة البيانات`); continue; }
    if (t.type !== "video") { errors.push(`المهمة ${tid} ليست مهمة فيديو (نوعها: ${t.type})`); continue; }
    if (t.status !== "completed" || !t.resultUrls?.length) {
      errors.push(`المهمة ${tid} غير مكتملة بعد (حالتها: ${t.status}) — أكملها بـ get_task أولًا`);
      continue;
    }
    urls.push(t.resultUrls[0]);
  }
  return { urls, errors };
}

export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds?: number;
  onProgress?: ProgressCb;
  signal?: AbortSignal;
}): Promise<MergeOutcome> {
  // (1) التحقق الصارم قبل أي تسجيل
  const resolved = await resolveTaskIds(opts.taskIds);
  const allUrls = [...resolved.urls, ...(opts.urls || [])];
  const details: string[] = [...resolved.errors];
  for (const u of opts.urls || []) {
    if (!/^https?:\/\//i.test(u)) details.push(`الرابط غير صالح (يجب أن يكون http/https مباشرًا وعامًا): ${u}`);
  }
  if (allUrls.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (details.length) msg += "\n\nتفاصيل المعرّفات الفاشلة:\n- " + details.join("\n- ");
    return { kind: "validation_error", message: msg };
  }
  if (allUrls.length > 10) {
    return { kind: "validation_error", message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  if (details.length) {
    // روابط/معرفات فاشلة وسط قائمة صالحة — نرفض حتى يصلحها العميل (معطيات لا يصلحها التبديل)
    return { kind: "validation_error", message: "❌ تعذر حل بعض المقاطع المطلوبة:\n- " + details.join("\n- ") };
  }

  // (2) تسجيل المهمة في Turso أولًا
  const taskId = randomUUID();
  const waitSeconds = Math.max(0, Math.min(240, Math.floor(Number(opts.waitSeconds)) || 60));
  let task = await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: "دمج مقاطع الفيديو",
    params: { urls: allUrls, waitSeconds, processStarted: false },
    status: "pending",
  });

  // (3) إنشاء مهمة لدى خدمة الدمج
  let jobId: string;
  try {
    const created = await mergerCreateJob(allUrls);
    jobId = created.jobId;
    task = (await updateTask(taskId, { provider: "merger", providerTaskId: jobId, status: "processing", progress: 3 }))!;
  } catch (e) {
    // خطأ معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري — لا إعادة محاولة
    const err = e as Error;
    task = (await updateTask(taskId, { status: "failed", errorMessage: err.message }))!;
    return { kind: "completed", task }; // انتهى برسالة فشل نهائية
  }

  // إطلاق process خلفيًا وبمرة واحدة فقط
  await startMergeProcess(taskId);

  // (4) نافذة الانتظار مع الاستعلام كل 3 ثوانٍ وبث التقدم
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { kind: "processing", task };
    await sleep(3000);
    let job;
    try {
      job = await mergerStatus(jobId);
    } catch (e) {
      // أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }
    if (job.status === "done" && job.videoUrl) {
      task = (await updateTask(taskId, { status: "completed", progress: 100, resultUrls: [job.videoUrl] }))!;
      await opts.onProgress?.(100, "اكتمل الدمج!");
      return { kind: "completed", task };
    }
    if (job.status === "failed") {
      // خطأ معلن من الخدمة = فشل نهائي فوري (مثل مصدر يرفض التحميل — التكرار يعطي النتيجة نفسها)
      task = (await updateTask(taskId, { status: "failed", errorMessage: job.error || "فشل تنفيذ الدمج لدى الخدمة" }))!;
      return { kind: "completed", task };
    }
    task = (await updateTask(taskId, { status: "processing", progress: job.progress }))!;
    await opts.onProgress?.(job.progress, `جارٍ الدمج… ${job.progress}%`);
  }

  // انتهت النافذة والنتيجة لم تظهر → processing والعميل يتابع بـ get_task
  return { kind: "processing", task };
}

// تنفيذ process مرة واحدة فقط لكل مهمة (قفل داخل الذاكرة)
async function startMergeProcess(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task?.providerTaskId || processInFlight.has(taskId) || task.params.processStarted) return;
  processInFlight.add(taskId);
  void (async () => {
    try {
      await updateTask(taskId, { params: { ...task.params, processStarted: true } });
      await mergerProcess(task.providerTaskId!); // 200 done أو 202 processing — الحالة تتابَع بالاستعلام
    } catch {
      // الفشل المعلن سينكشف في الاستعلام القادم (status=failed) — لا نتعامل هنا
    } finally {
      processInFlight.delete(taskId);
    }
  })();
}

// refreshMergeTask — لاستدعاءات get_task على مهمة دمج
export async function refreshMergeTask(task: Task): Promise<Task> {
  if (task.status === "completed" || task.status === "failed") return task;
  const jobId = task.providerTaskId;
  if (!jobId) {
    // لم تُنشأ مهمة لدى الخدمة بعد (بانتظار) — أعد الإنشاء بعد تهدئة
    const since = Date.parse(task.updatedAt.replace(" ", "T") + "Z") || Date.parse(task.updatedAt);
    if (Date.now() - since < 45_000) return task;
    const urls = (task.params.urls as string[]) || [];
    if (urls.length < 2) return task;
    try {
      const created = await mergerCreateJob(urls);
      const t = (await updateTask(task.id, { provider: "merger", providerTaskId: created.jobId, status: "processing", progress: 3 }))!;
      await startMergeProcess(task.id);
      return t;
    } catch (e) {
      return (await updateTask(task.id, { status: "failed", errorMessage: (e as Error).message }))!;
    }
  }

  let job;
  try {
    job = await mergerStatus(jobId);
  } catch (e) {
    // أخطاء شبكتنا = مؤقتة → استمر بالاستعلام
    return task;
  }
  // خدمة ردت 404 → فشل نهائي نهائيًا (mergerStatus يصوغ الرسالة العربية جاهزة)
  if (job.status === "done" && job.videoUrl) {
    return (await updateTask(task.id, { status: "completed", progress: 100, resultUrls: [job.videoUrl] }))!;
  }
  if (job.status === "failed") {
    return (await updateTask(task.id, { status: "failed", errorMessage: job.error || "فشل تنفيذ الدمج لدى الخدمة" }))!;
  }
  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (تحت القفل)
  const t2 = await getTask(task.id);
  if (t2 && !t2.params.processStarted) await startMergeProcess(task.id);
  return (await updateTask(task.id, { status: "processing", progress: job.progress }))!;
}

export { processInFlight, MERGER_BASE };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
