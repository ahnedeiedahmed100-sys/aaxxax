// عمليات المهام على Turso — insert/get/update(جزئي مع سجل المحاولات)/list/stats
import { getDb, ensureSchema } from "./turso";
import type { InValue } from "@libsql/client";
import type { TaskProvider, MediaType } from "./models";

export type TaskStatus = "pending" | "processing" | "completed" | "failed";

export interface TaskAttempt {
  provider: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface Task {
  id: string;
  provider: TaskProvider | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: number;
  resultUrls: string[] | null;
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function rowToTask(r: Record<string, unknown>): Task {
  let params: Record<string, unknown> = {};
  let attempts: TaskAttempt[] = [];
  let urls: string[] | null = null;
  try { params = JSON.parse((r.params_json as string) || "{}"); } catch { /* تجاهل */ }
  try { attempts = JSON.parse((r.attempts_json as string) || "[]"); } catch { /* تجاهل */ }
  try { urls = r.result_urls_json ? JSON.parse(r.result_urls_json as string) : null; } catch { /* تجاهل */ }
  return {
    id: r.id as string,
    provider: (r.provider as TaskProvider) || null,
    providerTaskId: (r.provider_task_id as string) || null,
    keyId: (r.key_id as string) || null,
    model: r.model as string,
    type: r.type as MediaType,
    prompt: (r.prompt as string) || "",
    params,
    status: r.status as TaskStatus,
    progress: Number(r.progress || 0),
    resultUrls: urls,
    errorMessage: (r.error_message as string) || null,
    attempts,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    completedAt: (r.completed_at as string) || null,
  };
}

interface TaskRow {
  id: string; provider: string | null; provider_task_id: string | null; key_id: string | null;
  model: string; type: string; prompt: string; params_json: string; status: string;
  progress: number; result_urls_json: string | null; error_message: string | null;
  attempts_json: string; created_at: string; updated_at: string; completed_at: string | null;
}

function taskToRow(t: Task): TaskRow {
  return {
    id: t.id,
    provider: t.provider,
    provider_task_id: t.providerTaskId,
    key_id: t.keyId,
    model: t.model,
    type: t.type,
    prompt: t.prompt,
    params_json: JSON.stringify(t.params || {}),
    status: t.status,
    progress: t.progress,
    result_urls_json: t.resultUrls ? JSON.stringify(t.resultUrls) : null,
    error_message: t.errorMessage,
    attempts_json: JSON.stringify(t.attempts || []),
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    completed_at: t.completedAt,
  };
}

export async function insertTask(input: {
  id: string; model: string; type: MediaType; prompt?: string;
  params?: Record<string, unknown>; status?: TaskStatus;
}): Promise<Task> {
  await ensureSchema();
  const task: Task = {
    id: input.id,
    provider: null,
    providerTaskId: null,
    keyId: null,
    model: input.model,
    type: input.type,
    prompt: input.prompt || "",
    params: input.params || {},
    status: input.status || "pending",
    progress: 0,
    resultUrls: null,
    errorMessage: null,
    attempts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
  };
  const r = taskToRow(task);
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.id, r.provider, r.provider_task_id, r.key_id, r.model, r.type, r.prompt, r.params_json, r.status, r.progress, r.result_urls_json, r.error_message, r.attempts_json, r.created_at, r.updated_at, null] as unknown as InValue[],
  });
  return task;
}

export async function getTask(id: string): Promise<Task | null> {
  await ensureSchema();
  const db = getDb();
  const res = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  if (!res.rows.length) return null;
  return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
}

// تحديث جزئي: يضيف المحاولات إلى السجل ويضبط completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, patch: Partial<Omit<Task, "id" | "attempts">> & { newAttempt?: TaskAttempt }): Promise<Task | null> {
  const current = await getTask(id);
  if (!current) return null;
  const merged: Task = {
    ...current,
    ...patch,
    attempts: patch.newAttempt ? [...current.attempts, patch.newAttempt] : current.attempts,
    completedAt: patch.status === "completed" ? new Date().toISOString() : current.completedAt,
  };
  if (patch.status !== "completed") merged.completedAt = current.completedAt;
  const r = taskToRow(merged);
  const db = getDb();
  await db.execute({
    sql: `UPDATE tasks SET provider = ?, provider_task_id = ?, key_id = ?, status = ?, progress = ?, result_urls_json = ?, error_message = ?, attempts_json = ?, updated_at = ?, completed_at = ?
          WHERE id = ?`,
    args: [r.provider, r.provider_task_id, r.key_id, r.status, r.progress, r.result_urls_json, r.error_message, r.attempts_json, new Date().toISOString(), r.completed_at, id] as unknown as InValue[],
  });
  return merged;
}

export async function listRecentTasks(limit = 10, filter?: { type?: MediaType; status?: TaskStatus }): Promise<Task[]> {
  await ensureSchema();
  const db = getDb();
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter?.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { where.push("status = ?"); args.push(filter.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, updated_at DESC LIMIT ?`;
  args.push(limit);
  const res = await db.execute({ sql, args });
  return res.rows.map((x) => rowToTask(x as unknown as Record<string, unknown>));
}

export interface TaskStats { total: number; completed: number; failed: number; processing: number; }

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const db = getDb();
  const res = await db.execute("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status");
  const stats: TaskStats = { total: 0, completed: 0, failed: 0, processing: 0 };
  for (const row of res.rows) {
    const c = Number(row.c);
    stats.total += c;
    if (row.status === "completed") stats.completed = c;
    else if (row.status === "failed") stats.failed = c;
    else if (row.status === "processing" || row.status === "pending") stats.processing += c;
  }
  return stats;
}
