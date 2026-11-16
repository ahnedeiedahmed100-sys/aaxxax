// منسّق الدمج الكامل — مسار واحد متزامن: سحب المصادر → فحص → ترميز → تخزين الناتج كصفوف Blob.
// خريطة التقدم: 0–40 سحب المصادر، 40–90 ترميز ffmpeg، 90–100 حفظ الناتج، 100 اكتمال.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { getDb, getJob, updateJob, listSources } = require("./db");
const { writeBlob, assembleSourceChunks, deleteSourceChunks } = require("./storage");
const { probeFile, resolveFfmpeg, buildMergeArgs, runFfmpegWithProgress } = require("./media");
const { SOURCE_MAX_MB, OUTPUT_MAX_MB, MAX_TOTAL_DURATION_SEC } = require("./limits");

// قفل داخل الذاكرة يمنع تنفيذ الدمج مرتين بتزامن على نفس المهمة
const mergeInFlight = new Set();

async function downloadWithCap(url, destPath, capBytes) {
  // سحب المصدر من الرابط مع عدّاد بايتات — تجاوز الحد = فشل واضح وليس انهيارًا
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`تعذر تنزيل المصدر (${url}): HTTP ${res.status}`);
  }
  const stream = fs.createWriteStream(destPath);
  let total = 0;
  const reader = res.body.getReader();
  await new Promise((resolve, reject) => {
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > capBytes) {
            reader.cancel().catch(() => {});
            throw new Error(`حجم المصدر يتجاوز الحد المسموح (${SOURCE_MAX_MB}MB): ${url}`);
          }
          if (!stream.write(Buffer.from(value))) {
            await new Promise((r) => stream.once("drain", r));
          }
        }
        stream.end(() => resolve());
      } catch (e) { reject(e); }
    };
    pump();
  });
  return total;
}

// التحقق من جهوزية كل المصادر قبل بدء الدمج
async function assertSourcesReady(jobId) {
  const sources = await listSources(jobId);
  for (const s of sources) {
    if (s.kind === "url") continue; // الروابط تسحب عند التنفيذ
    if (s.uploadedChunks <= 0) {
      throw Object.assign(new Error(`الملف المرفوع "${s.name || `#${s.seq}`}" لم يكتمل بعد`), { code: 409 });
    }
  }
  return sources;
}

async function runMergeJob(jobId, onProgress) {
  const job = await getJob(jobId);
  if (!job) throw Object.assign(new Error("المهمة غير موجودة"), { code: 404 });
  if (job.status === "processing" || mergeInFlight.has(jobId)) {
    throw Object.assign(new Error("المهمة قيد المعالجة بالفعل"), { code: 202 });
  }

  mergeInFlight.add(jobId);
  const tmpDir = path.join(os.tmpdir(), `vm-${jobId}`);
  try {
    const sources = await assertSourcesReady(jobId);
    await updateJob(jobId, { status: "processing", progress: 0, error: null });

    fs.mkdirSync(tmpDir, { recursive: true });
    const localPaths = [];
    const probes = [];

    // (1) سحب المصادر: روابط عبر fetch مع حد الحجم، أو تجميع الأجزاء المرفوعة من القاعدة
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src-${i}.bin`);
      if (s.kind === "url") {
        await downloadWithCap(s.url, dest, SOURCE_MAX_MB * 1024 * 1024);
      } else {
        const buf = await assembleSourceChunks(jobId, s.seq);
        if (buf.length > SOURCE_MAX_MB * 1024 * 1024) {
          throw new Error(`حجم الملف المرفوع يتجاوز الحد المسموح (${SOURCE_MAX_MB}MB)`);
        }
        fs.writeFileSync(dest, buf);
      }
      localPaths.push(dest);
      // فحص كل مصدر فور جلبه لرفض الملفات التالفة مبكرًا
      let probe;
      try {
        probe = await probeFile(dest);
      } catch (e) {
        throw new Error(`فشل فحص المصدر ${i + 1} (${s.name || s.url || ""}): ${e.message}`);
      }
      probes.push(probe);
      // تخزين نتيجة الفحص للعرض
      const db = getDb();
      await db.execute({ sql: "UPDATE sources SET probe_json = ?, size = ? WHERE job_id = ? AND seq = ?", args: [JSON.stringify(probe), probe.duration ? Math.round(fs.statSync(dest).size) : 0, jobId, s.seq] });
      if (onProgress) await onProgress(Math.round(((i + 1) / sources.length) * 40));
    }

    // (2) التحقق من الحدود: المدة الإجمالية
    const totalDuration = probes.reduce((a, p) => a + p.duration, 0);
    if (totalDuration > MAX_TOTAL_DURATION_SEC) {
      throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد المسموح (${MAX_TOTAL_DURATION_SEC} ثانية)`);
    }

    // (3) الترميز الموحد مع تقدم حي 40–90
    const ffmpegBin = resolveFfmpeg();
    const outPath = path.join(tmpDir, "out.mp4");
    const { args } = buildMergeArgs({ inputPaths: localPaths, probes, outPath });
    await runFfmpegWithProgress(ffmpegBin, args, totalDuration, (pct) => {
      if (onProgress) void onProgress(40 + Math.round(pct * 0.5)).catch(() => {});
    });

    // (4) فحص حجم الناتج
    const outSize = fs.statSync(outPath).size;
    if (outSize > OUTPUT_MAX_MB * 1024 * 1024) {
      throw new Error(`حجم الناتج (${(outSize / (1024 * 1024)).toFixed(1)}MB) يتجاوز الحد المسموح (${OUTPUT_MAX_MB}MB)`);
    }

    // (5) حفظ الناتج كصفوف Blob وحذف أجزاء المصادر — الناتج فقط هو المطلوب
    if (onProgress) await onProgress(90).catch(() => {});
    const data = fs.readFileSync(outPath);
    const rows = await writeBlob("output_chunks", ["job_id"], [jobId], data);
    await deleteSourceChunks(jobId);

    // فحص الناتج النهائي عبر ffprobe للدقة والمدة الفعلية (مع قيم محسوبة كاحتياط)
    let finalDuration = Math.round(totalDuration * 100) / 100;
    let finalResolution = null;
    try {
      const { probeFile: probeOut } = require("./media");
      const out = await probeOut(outPath);
      finalDuration = Math.round(out.duration * 100) / 100;
      finalResolution = `${out.width}x${out.height}`;
    } catch { /* نستخدم القيم المحسوبة */ }
    if (!finalResolution) {
      const maxW = Math.max(...probes.map((p) => p.width));
      const maxH = Math.max(...probes.map((p) => p.height));
      finalResolution = `${Math.min(maxW, 1920)}x${Math.min(maxH, 1080)}`;
    }

    await updateJob(jobId, {
      status: "done",
      progress: 100,
      videoSize: outSize,
      videoDuration: finalDuration,
      videoResolution: finalResolution,
      outputChunks: rows,
      error: null,
    });
    return { size: outSize, duration: finalDuration, resolution: finalResolution };
  } catch (e) {
    // فشل واضح برسالة عربية — حالة المهمة تفشل ولا يحدث انهيار
    const msg = e.message || "خطأ غير معروف أثناء الدمج";
    await updateJob(jobId, { status: "failed", error: msg }).catch(() => {});
    throw e;
  } finally {
    mergeInFlight.delete(jobId);
    // تنظيف /tmp في كل الحالات — لا اعتماد على ملفات دائمة
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { runMergeJob, mergeInFlight, assertSourcesReady };
