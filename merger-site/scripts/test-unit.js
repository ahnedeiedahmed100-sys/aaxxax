// اختبار وحدات شامل لمحرك الدمج والتخزين (يولّد فيديوهين مختلفي الدقة بـ ffmpeg، يدمجهما، ويتحقق
// من الدقة/المدة/الصوت ثم التخزين في القاعدة والاسترجاع بتطابق sha256 ومسار الرفع والحدود والحذف).
// التشغيل: node scripts/test-unit.js
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

// تحميل .env يدويًا (نفس سلوك server.js)
(function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("="); if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
})();

const { createJob, insertSource, getJob, deleteJobRows } = require("../lib/db");
const { writeBlob, readBlobAll, appendSourceChunk, assembleSourceChunks } = require("../lib/storage");
const { runMergeJob } = require("../lib/mergeRunner");
const { probeFile, resolveFfmpeg } = require("../lib/media");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

function generateTestVideo(outPath, w, h, seconds, withAudio) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (withAudio) {
      args.push(
        "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30:duration=${seconds}`,
        "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", outPath
      );
    } else {
      args.push(
        "-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`,
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", outPath
      );
    }
    const child = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err))));
  });
}

// خادم ملفات ثابت صغير داخل الاختبار — لتقديم روابط http للمصادر
function serveStatic(dir, port) {
  const server = http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(req.url.split("?")[0]));
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.setHeader("Content-Type", "video/mp4");
      fs.createReadStream(f).pipe(res);
    } else { res.statusCode = 404; res.end("nope"); }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

async function readOutToTmp(jobId, tmp) {
  const outPath = path.join(tmp, `out-${jobId}.mp4`);
  const { buf } = await readBlobAll("output_chunks", ["job_id"], [jobId]);
  fs.writeFileSync(outPath, buf);
  return { outPath, buf };
}

async function main() {
  console.log("\n=== اختبار وحدات خدمة دمج الفيديو ===\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vm-unit-"));

  // (1) توليد مصدرين مختلفي الدقة — الأول بصوت والثاني صامت
  console.log("[1] توليد مقاطع الاختبار…");
  const v1 = path.join(tmp, "v1-960x540-5s-audio.mp4");
  const v2 = path.join(tmp, "v2-640x360-4s-silent.mp4");
  await generateTestVideo(v1, 960, 540, 5, true);
  await generateTestVideo(v2, 640, 360, 4, false);
  const p1 = await probeFile(v1);
  const p2 = await probeFile(v2);
  check("توليد المصدر الأول (960x540، 5 ثوان، بصوت)", p1.width === 960 && p1.height === 540 && p1.hasAudio && Math.abs(p1.duration - 5) < 1);
  check("توليد المصدر الثاني (640x360، 4 ثوان، صامت)", p2.width === 640 && p2.height === 360 && !p2.hasAudio);

  // (2) دمج من روابط عبر المسار الكامل (سحب → توحيد → ترميز → تخزين)
  console.log("\n[2] دمج من روابط عبر المسار الكامل…");
  const server = await serveStatic(tmp, 3100);
  const base = "http://127.0.0.1:3100";
  const job1 = "unitjob" + Math.random().toString(36).slice(2, 8);
  await createJob({ id: job1, sourcesCount: 2, hasFiles: false });
  await insertSource(job1, 0, { kind: "url", url: `${base}/v1-960x540-5s-audio.mp4` });
  await insertSource(job1, 1, { kind: "url", url: `${base}/v2-640x360-4s-silent.mp4` });
  await runMergeJob(job1);
  const j1 = await getJob(job1);
  check("اكتمال الدمج (done, progress=100)", j1 && j1.status === "done" && j1.progress === 100, `status=${j1 && j1.status}`);
  check("الدقة الناتجة = أكبر دقة مدخل (960x540)", j1.videoResolution === "960x540", `got ${j1.videoResolution}`);
  const sumDur = p1.duration + p2.duration;
  check(`المدة ≈ مجموع المدد (${sumDur.toFixed(1)}±2)`, Math.abs(j1.videoDuration - sumDur) < 2, `got ${j1.videoDuration}`);

  // (3) وجود الصوت في الناتج — المقطع الصامت حصل على مسار صامت بدل الفشل
  const r1 = await readOutToTmp(job1, tmp);
  const outProbe = await probeFile(r1.outPath);
  check("الناتج يحتوي مسار صوت (المصدر الصامت أُكمل بمسار anullsrc)", outProbe.hasAudio === true);
  check("حجم الناتج معقول (>0)", j1.videoSize > 0);

  // (4) التخزين والاسترجاع بتطابق sha256
  console.log("\n[4] التخزين في القاعدة والاسترجاع…");
  const blobSize = await require("../lib/storage").blobSize("output_chunks", ["job_id"], [job1]);
  check("حجم Blob في القاعدة = حجم الملف", blobSize === j1.videoSize, `blob=${blobSize} file=${j1.videoSize}`);
  const crypto = require("node:crypto");
  const shaFile = crypto.createHash("sha256").update(r1.buf).digest("hex");
  const shaAgain = (await readBlobAll("output_chunks", ["job_id"], [job1])).sha256;
  check("sha256 متطابق بين قراءتين تدفقيّتين", shaFile === shaAgain);

  // (5) مسار رفع الأجزاء: مهمة ملفات (تقسيم 2MB + تجميع + دمج)
  console.log("\n[5] مسار رفع الأجزاء (file sources)…");
  const job2 = "unitjob" + Math.random().toString(36).slice(2, 8);
  await createJob({ id: job2, sourcesCount: 2, hasFiles: true });
  await insertSource(job2, 0, { kind: "file", name: "v1.mp4", mime: "video/mp4", size: fs.statSync(v1).size });
  await insertSource(job2, 1, { kind: "file", name: "v2.mp4", mime: "video/mp4", size: fs.statSync(v2).size });
  // رفع v1 كأجزاء 1MB (عمدًا أقل من صف الـ 2MB لاختبار التقسيم) وv2 كجزء واحد
  const b1 = fs.readFileSync(v1);
  const CH = 1024 * 1024;
  for (let k = 0; k * CH < b1.length; k++) {
    await appendSourceChunk(job2, 0, k, b1.subarray(k * CH, Math.min((k + 1) * CH, b1.length)));
  }
  await appendSourceChunk(job2, 1, 0, fs.readFileSync(v2));
  const assembled = await assembleSourceChunks(job2, 0);
  check("تجميع الأجزاء المرفوعة يطابق الأصل بالبايت", assembled.equals(b1));
  await runMergeJob(job2);
  const j2 = await getJob(job2);
  check("اكتمال دمج الملفات المرفوعة", j2.status === "done", `error=${j2.error}`);
  check("أجزاء المصادر حُذفت بعد النجاح", (await require("../lib/db").getDb().execute({ sql: "SELECT COUNT(*) AS c FROM source_chunks WHERE job_id = ?", args: [job2] })).rows[0].c === 0);

  // (6) الحدود: رفض مهمة بها مصدر واحد عبر التحقق (المصدر الواحد يرفض في طبقة API، هنا نفحص وجود الأجزاء والسلوك)
  console.log("\n[6] حدود وحذف شامل…");
  await deleteJobRows(job2);
  const gone = await getJob(job2);
  check("الحذف الشامل يزيل صفوف المهمة", gone === null);
  await deleteJobRows(job1); // تنظيف

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nالنتيجة: ${passed} نجاح، ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("فشل غير متوقع:", e); process.exit(1); });
