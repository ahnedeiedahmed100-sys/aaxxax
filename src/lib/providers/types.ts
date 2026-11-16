// واجهة المزودات الموحدة + خطأ موسوم يُصنَّف لاحقًا في classifyProviderError
export interface ProviderKey {
  id: string;
  label: string;
  apiKey: string;
}

export interface ProviderError extends Error {
  status?: number; // حالة HTTP إن وجدت — الغياب يعني خطأ شبكة/timeout
}

export function providerError(message: string, status?: number): ProviderError {
  const e = new Error(message) as ProviderError;
  e.status = status;
  return e;
}

export interface CreateTaskResult { providerTaskId: string; }
export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}
export interface CreateImageSyncResult { urls: string[]; }

// واجهة المزود: مهام غير متزامنة (فيديو وبعض الصور) + صور متزامنة اختيارية + استعلام حالة
export interface ProviderAdapter {
  createTask(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<CreateTaskResult>;
  createImageSync?(key: ProviderKey, providerModel: string, input: Record<string, unknown>): Promise<CreateImageSyncResult>;
  checkTask(key: ProviderKey, providerTaskId: string): Promise<CheckTaskResult>;
}

// fetch مع مهلة لتفادي التعليق على المزود
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: unknown) {
    // نقنّع AbortError بخطأ شبكة واضح (يبقى بلا status → temporary)
    const err = e as Error;
    if (err.name === "AbortError") throw providerError(`انتهت مهلة الاتصال بالمزود (${timeoutMs}ms)`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// استخراج رسالة خطأ متسامحة من جسم غير معلوم الشكل
export function extractErrorMessage(body: unknown, fallbackStatus?: number): string {
  if (!body) return fallbackStatus ? `HTTP ${fallbackStatus}` : "خطأ غير معروف من المزود";
  const b = body as Record<string, unknown>;
  for (const k of ["msg", "message", "error", "error_msg", "detail"]) {
    const v = b[k];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).message ?? (v as Record<string, unknown>).msg;
      if (typeof inner === "string" && inner) return inner;
    }
  }
  return fallbackStatus ? `HTTP ${fallbackStatus}` : "خطأ غير معروف من المزود";
}
