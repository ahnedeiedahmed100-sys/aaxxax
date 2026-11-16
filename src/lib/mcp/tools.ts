// أدوات MCP الخمس — الأوصاف بالإنجليزية (يقرأها العميل) والنتائج بالعربية.
// المخططات مطابقة حرفيًا لما في المواصفة (merge بدون resolution/fps وبحد 10).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runGeneration, refreshTask } from "../generation";
import { runMerge, refreshMergeTask } from "../merge";
import { getTask, listRecentTasks, type Task } from "../tasks";
import type { ProgressCb } from "../generation";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// SERVER_INSTRUCTIONS — نص جاهز يُرسل مع initialize
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

interface ExtraLike {
  _meta?: { progressToken?: unknown };
  requestInfo?: { _meta?: { progressToken?: unknown } };
  sendNotification?: (n: unknown) => Promise<void>;
  signal?: AbortSignal;
}

// استخراج progressToken من _meta إن زوّده العميل، وبناء مرسل تقدم عربي كل ~3 ثوانٍ
function makeProgressCb(extra: ExtraLike, total: number): ProgressCb | undefined {
  const token = extra?._meta?.progressToken ?? extra?.requestInfo?._meta?.progressToken;
  if (token === undefined || token === null) return undefined;
  return async (progress: number, message: string) => {
    try {
      await extra.sendNotification?.({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch { /* العميل قد يكون انقطع — نتجاهل */ }
  };
}

// ---------- صياغة الردود العربية ----------
function fmtCompleted(t: Task): { text: string; isError?: boolean } {
  const urls = t.resultUrls || [];
  if (t.type === "image") {
    const lines = ["✅ تم توليد الصورة بنجاح"];
    if (urls[0]) lines.push("", `![image](<${urls[0]}>)`);
    if (urls[0]) lines.push("", `الرابط المباشر: ${urls[0]}`);
    return { text: lines.join("\n") };
  }
  if (t.type === "video") {
    const lines = ["✅ تم توليد الفيديو بنجاح", "", ...urls.map((u) => `الرابط المباشر: ${u}`)];
    return { text: lines.join("\n") };
  }
  // دمج
  const lines = ["✅ تم دمج المقاطع بنجاح", "", ...urls.map((u) => `الرابط المباشر: ${u}`), "", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا."];
  return { text: lines.join("\n") };
}

function fmtProcessing(t: Task): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${t.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function fmtFailed(t: Task): { text: string; isError: true } {
  return { text: `❌ فشلت المهمة: ${t.errorMessage || "سبب غير معروف"}`, isError: true };
}

function fmtTask(t: Task): { text: string; isError?: boolean } {
  if (t.status === "completed") return fmtCompleted(t);
  if (t.status === "failed") return fmtFailed(t);
  return { text: fmtProcessing(t) };
}

function asToolResult(r: { text: string; isError?: boolean }) {
  return {
    content: [{ type: "text" as const, text: r.text }],
    ...(r.isError ? { isError: true as const } : {}),
  };
}

const WAIT = (dflt: number) =>
  z.number().int().min(0).max(240).default(dflt).describe("Seconds to wait for the result during this call (0–240); if it is not ready yet you get a task_id — keep polling get_task.");

// فحص عربي مسبق لقواعد الدمج (معيار القبول 9): رفض <2 و >10 برسائل المواصفة الصحيحة.
// المخطط نفسه يظل مطابقًا للمواصفة (minItems 2 / maxItems 10 في tools/list)، لكن الـ SDK
// يرفض الخرق برسالة إنجليزية قبل وصول الأداة — فنلتقط الحالتين هنا ونعطي الرسالة العربية.
export function arabicMergePrecheck(parsedBody: unknown): string | null {
  const b = parsedBody as { method?: string; id?: unknown; params?: { name?: string; arguments?: { urls?: unknown[]; task_ids?: unknown[] } } } | null;
  if (!b || b.method !== "tools/call" || b.params?.name !== "merge_videos" || b.id === undefined || b.id === null) return null;
  const args = b.params.arguments || {};
  const urls = Array.isArray(args.urls) ? args.urls : [];
  const taskIds = Array.isArray(args.task_ids) ? args.task_ids : [];
  const total = urls.length + taskIds.length;
  if (total > 10) return "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).";
  if (total < 2) return "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
  return null;
}

// ---------- تسجيل الأدوات الخمس ----------
export function registerTools(server: McpServer): void {
  // (1) generate_image
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description: "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). Returns a ready image URL if it finishes within the wait window, otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"]).default("gpt-image-2-6/flare-text-to-image").describe("Image model (canonical or dotted alias)."),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"]).default("auto").describe("Output aspect ratio."),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K").describe("Resolution tier."),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png").describe("Output file format."),
        wait_seconds: WAIT(90),
      },
    },
    async (args, extra) => {
      const out = await runGeneration({
        type: "image",
        args: args as Record<string, unknown>,
        waitSeconds: args.wait_seconds,
        onProgress: makeProgressCb(extra as ExtraLike, 100),
        signal: (extra as ExtraLike).signal,
      });
      if (out.kind === "params_error") return asToolResult({ text: out.message, isError: true });
      // fmtTask يفحص الحالة الفعلية: completed ← نجاح، failed ← خطأ، غيرها ← قيد المعالجة
      return asToolResult(fmtTask(out.task));
    }
  );

  // (2) generate_video
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description: "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio — dialogue/effects/music; optional image-to-video). Videos take minutes: short wait with live progress streaming, then a task_id — track with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview").describe("Video model (canonical or dotted alias)."),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto").describe("Output aspect ratio."),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p").describe("Output resolution."),
        enable_audio: z.boolean().default(true).describe("Generate native synchronized audio."),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: WAIT(25),
      },
    },
    async (args, extra) => {
      const out = await runGeneration({
        type: "video",
        args: args as Record<string, unknown>,
        waitSeconds: args.wait_seconds,
        onProgress: makeProgressCb(extra as ExtraLike, 100),
        signal: (extra as ExtraLike).signal,
      });
      if (out.kind === "params_error") return asToolResult({ text: out.message, isError: true });
      return asToolResult(fmtTask(out.task));
    }
  );

  // (3) merge_videos — بلا resolution/fps وبحد 10 (الناتج ثابت من خدمة الدمج)
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description: "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. from generate_video) or 'task_ids' (completed video generation tasks — their result URLs are resolved from the database in this order; ideal after generating several clips). Merging is usually quick: short wait with live progress, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).optional().describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).min(2).max(10).optional().describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: WAIT(60),
      },
    },
    async (args, extra) => {
      const out = await runMerge({
        urls: args.urls,
        taskIds: args.task_ids,
        waitSeconds: args.wait_seconds,
        onProgress: makeProgressCb(extra as ExtraLike, 100),
        signal: (extra as ExtraLike).signal,
      });
      if (out.kind === "validation_error") return asToolResult({ text: out.message || "❌ معطيات الدمج غير صالحة", isError: true });
      return asToolResult(fmtTask(out.task!));
    }
  );

  // (4) get_task — تتبع أي مهمة (توليد أو دمج)
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description: "Track any task by its id — image/video generation AND merging. Reads the Turso database and refreshes live from the provider/merging service if still in progress. Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args) => {
      const existing = await getTask(args.task_id);
      if (!existing) {
        return asToolResult({ text: `❌ لا توجد مهمة بالمعرّف ${args.task_id}. تحقق من المعرّف أو استخدم list_media لعرض المهام المخزنة.`, isError: true });
      }
      // مهمة دمج → refreshMergeTask، غيرها → refreshTask (تحديث حي مع منطق التبديل نفسه)
      const fresh = existing.type === "merge" ? await refreshMergeTask(existing) : await refreshTask(existing);
      return asToolResult(fmtTask(fresh));
    }
  );

  // (5) list_media — استرجاع الوسائط المخزنة
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description: "Latest stored images/videos/merges with their URLs from the database (no re-generation) — recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional().describe("Filter by media type."),
        status: z.enum(["completed", "failed", "processing"]).optional().describe("Filter by task status."),
        limit: z.number().int().min(1).max(50).default(10).describe("How many tasks to return."),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, { type: args.type, status: args.status as never });
      if (!tasks.length) {
        return asToolResult({ text: "لا توجد مهام مخزنة بعد بهذه الفلاتر — أنشئ وسائط جديدة بـ generate_image أو generate_video أولًا." });
      }
      const lines = tasks.map((t, i) => {
        // تسمية النوع بالعربية (المواصفة: كل رسائل الأدوات بالعربية) — وتفادي أثر مكنس [m في بعض الطرفيات
        const typeLabel = t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : "دمج";
        const statusLabel = t.status === "completed" ? "مكتملة" : t.status === "failed" ? "فاشلة" : t.status === "processing" ? "جارية" : "بالانتظار";
        const head = `${i + 1}. (${typeLabel}) ${statusLabel} — ${t.id} — موديل: ${t.model}${t.prompt ? ` — «${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? "…" : ""}»` : ""}`;
        if (t.status === "completed" && t.resultUrls?.length) return `${head}\n   الروابط: ${t.resultUrls.join(" ، ")}`;
        return head;
      });
      return asToolResult({ text: `أحدث ${tasks.length} وسائط مخزنة (من الأحدث):\n\n${lines.join("\n")}` });
    }
  );
}
