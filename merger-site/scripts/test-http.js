// اختبار HTTP كامل ضد خادم التطوير المحلي (node server.js على 3001):
// إنشاء من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → قائمة فارغة.
// التشغيل: node scripts/test-http.js  (يتطلب خادمًا يعمل على PORT 3001، وسيرفع خادمًا داخليًا للمقاطع على 3101)
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const BASE = process.env.TEST_BASE || "http://localhost:3001";
const resolveFfmpeg = () => process.env.FFMPEG_BIN || (() => { try { return require("ffmpeg-static"); } catch { return "ffmpeg"; } })();

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

async function api(method, p, { body, raw, headers = {} } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: raw ? { "Content-Type": "application/octet-stream", ...headers } : { "Content-Type": "application/json", ...headers },
    body: raw ? raw : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* جسم غير JSON (مثل MP4) */ }
  return { status: res.status, json, text, headers: res.headers };
}

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

function waitForServer(maxMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ping = async () => {
      try { const r = await fetch(BASE + "/api/config"); if (r.ok) return resolve(true); } catch {}
      if (Date.now() - t0 > maxMs) return reject(new Error("خادم التطوير لم يستجب — شغّله أولًا: node server.js"));
      setTimeout(ping, 400);
    };
    ping();
  });
}

function generateTestVideo(outPath, w, h, seconds, withAudio) {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (withAudio) {
      args.push("-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", outPath);
    } else {
      args.push("-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=30:duration=${seconds}`, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", outPath);
    }
    const child = spawn(resolveFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (c) => (c === 0 ? resolve() : reject(new Error(err))));
  });
}

async function main() {
  console.log("\n=== اختبار HTTP كامل لخدمة الدمج (ضد " + BASE + ") ===\n");
  await waitForServer();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vm-http-"));
  const svr = await serveStatic(tmp, 3101);
  const base = "http://127.0.0.1:3101";

  // (1) إنشاء مهمة من روابط → دمج → نتيجة
  console.log("[1] إنشاء من روابط → دمج → نتيجة");
  await generateTestVideo(path.join(tmp, "a.mp4"), 480, 360, 3, true);
  await generateTestVideo(path.join(tmp, "b.mp4"), 320, 240, 3, false);
  let r = await api("POST", "/api/jobs", { body: { videos: [`${base}/a.mp4`, `${base}/b.mp4`] } });
  check("إنشاء المهمة يعيد 201 + jobId + statusUrl", r.status === 201 && !!r.json.jobId && !!r.json.statusUrl, JSON.stringify(r.json));
  const job1 = r.json.jobId;
  check("expiresAt بعد ~24 ساعة", r.json.expiresAt && (new Date(r.json.expiresAt) - Date.now()) > 23 * 3600e3);

  r = await api("POST", `/api/jobs/${job1}/process`);
  check("تنفيذ الدمج يعيد 200 + status=done + videoUrl", r.status === 200 && r.json.status === "done" && !!r.json.videoUrl, JSON.stringify(r.json).slice(0, 200));
  check("الدقة = أكبر دقة (480x360)", r.json.resolution === "480x360", `got ${r.json.resolution}`);
  const durSum = r.json.duration;

  // (2) بث الناتج بدعم Range
  console.log("\n[2] البث بدعم Range");
  let vid = await fetch(`${BASE}/api/jobs/${job1}/video`, { headers: { Range: "bytes=100-999" } });
  const vbuf = Buffer.from(await vid.arrayBuffer());
  check("Range يعيد 206 + Content-Range صحيح", vid.status === 206 && vid.headers.get("content-range") === `bytes 100-999/${r.json.size}`, vid.headers.get("content-range"));
  check("طول المدى المطلوب مطابق (900 بايت)", vbuf.length === 900, `got ${vbuf.length}`);
  vid = await fetch(`${BASE}/api/jobs/${job1}/video`);
  check("بث كامل يعيد 200 + Accept-Ranges", vid.status === 200 && vid.headers.get("accept-ranges") === "bytes");
  vid = await fetch(`${BASE}/api/jobs/${job1}/video?download=1`);
  check("download=1 يعيد Content-Disposition", (vid.headers.get("content-disposition") || "").includes("attachment"));

  // (3) مهمة مختلطة: رابط + ملف مرفوع بأجزاء
  console.log("\n[3] مهمة مختلطة (رابط + ملف مرفوع)");
  r = await api("POST", "/api/jobs", { body: { sources: [ { kind: "url", url: `${base}/a.mp4` }, { kind: "file", name: "b.mp4", size: fs.statSync(path.join(tmp, "b.mp4")).size, mime: "video/mp4" } ] } });
  check("إنشاء مهمة مختلطة يعيد uploads[] + uploadChunkBytes", r.status === 201 && Array.isArray(r.json.uploads) && !!r.json.uploadChunkBytes, JSON.stringify(r.json).slice(0, 150));
  const job2 = r.json.jobId;
  const fdata = fs.readFileSync(path.join(tmp, "b.mp4"));
  const CH = 1024 * 1024;
  for (let k = 0; k * CH < fdata.length; k++) {
    const part = fdata.subarray(k * CH, Math.min((k + 1) * CH, fdata.length));
    const up = await api("POST", `/api/upload?job=${job2}&seq=1&chunk=${k}`, { raw: part });
    check(`رفع الجزء ${k} يعيد 200`, up.status === 200 && up.json.ok === true, JSON.stringify(up.json).slice(0, 120));
  }
  r = await api("POST", `/api/jobs/${job2}/process`);
  check("دمج المهمة المختلطة يكتمل", r.status === 200 && r.json.status === "done", JSON.stringify(r.json).slice(0, 200));
  // إعادة استدعاء process على مهمة مكتملة = تعاودي
  r = await api("POST", `/api/jobs/${job2}/process`);
  check("process على مهمة مكتملة تعاودي (يعيد النتيجة)", r.status === 200 && r.json.status === "done");

  // (4) الأخطاء المتوقعة
  console.log("\n[4] الأخطاء المتوقعة");
  r = await api("GET", "/api/jobs/nonexist999");
  check("مهمة غير موجودة → 404", r.status === 404);
  r = await api("POST", "/api/jobs", { body: {} });
  check("قائمة فارغة → 400 برسالة عربية", r.status === 400 && /(مقطع|مصفوفة)/.test(r.json.error || ""), r.json && r.json.error);
  r = await api("POST", "/api/jobs", { body: { videos: [`${base}/a.mp4`] } });
  check("مصدر واحد → 400", r.status === 400);
  r = await api("POST", "/api/jobs", { body: { videos: Array.from({ length: 11 }, () => `${base}/a.mp4`) } });
  check("أكثر من 10 → 400 برسالة الحد", r.status === 400 && /10/.test(r.json.error || ""));
  const raw = await fetch(BASE + "/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "not-json{{" });
  check("JSON تالف → 400", raw.status === 400);
  r = await api("DELETE", "/api/jobs/" + job1);
  check("حذف فوري → ok:true", r.status === 200 && r.json.ok === true);
  r = await api("GET", "/api/jobs/" + job1);
  check("بعد الحذف → 404", r.status === 404);
  r = await api("GET", `/api/jobs/${job2}/video`);
  check("بث مهمة غير محذوفة يعمل", r.status === 200 || r.status === 206);

  // (5) config
  r = await api("GET", "/api/config");
  check("config يعيد الحدود + version", r.status === 200 && r.json.limits && r.json.limits.maxSources === 10 && !!r.json.version);
  void durSum;

  svr.close();
  await api("DELETE", "/api/jobs/" + job2); // تنظيف آثار الاختبار
  console.log(`\nالنتيجة: ${passed} نجاح، ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("فشل غير متوقع:", e); process.exit(1); });
