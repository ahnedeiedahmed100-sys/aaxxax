// محرك الدمج — ffmpeg + ffprobe داخل الدالة نفسها مع ضمان صلاحية التنفيذ وتقدم حي.
// توحيد كل المصادر: scale + pad إلى أكبر دقة (حد 1920x1080، أبعاد زوجية)، fps=30، setsar=1، yuv420p، ثم concat.
// الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + +faststart — MP4 عالي الجودة يعمل فورًا على الويب.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { FFMPEG_PRESET } = require("./limits");

// التحقق من قابلية التنفيذ، وإلا ننسخ الثنائي إلى /tmp بصلاحية 755 (بعض الاستضافات تفقد +x)
function ensureExecutable(binPath, tag) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `vm-${tag}-${path.basename(binPath)}`);
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

// حل مسار ffmpeg: متغير بيئة اختياري ثم ffmpeg-static ثم النظام
function resolveFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return ensureExecutable(process.env.FFMPEG_BIN, "ffmpeg");
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return ensureExecutable(p, "ffmpeg");
  } catch { /* غير مثبت — نعتمد النظام */ }
  return "ffmpeg"; // من PATH
}

function resolveFfprobe() {
  if (process.env.FFPROBE_BIN && fs.existsSync(process.env.FFPROBE_BIN)) return ensureExecutable(process.env.FFPROBE_BIN, "ffprobe");
  try {
    const m = require("ffprobe-static");
    const p = m && (m.path || m);
    if (p && fs.existsSync(p)) return ensureExecutable(p, "ffprobe");
  } catch { /* غير مثبت */ }
  return "ffprobe";
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(bin)} خرج برمز ${code}: ${stderr.slice(-800)}`))));
  });
}

// ffprobe لملف: الدقة، معدل الإطارات، المدة، وجود صوت
async function probeFile(filePath) {
  const bin = resolveFfprobe();
  const { stdout } = await run(bin, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ]);
  const info = JSON.parse(stdout);
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("الملف لا يحتوي مسار فيديو صالحًا");
  const fpsNum = (video.avg_frame_rate || video.r_frame_rate || "0/1").split("/");
  const fps = fpsNum.length === 2 && Number(fpsNum[1]) ? Number(fpsNum[0]) / Number(fpsNum[1]) : Number(fpsNum[0]) || 30;
  const duration = Number(video.duration || info.format?.duration || 0);
  if (!duration || duration <= 0) throw new Error("تعذر تحديد مدة الملف");
  return {
    width: video.width, height: video.height,
    fps: Math.round(fps * 100) / 100,
    duration,
    hasAudio: !!audio,
  };
}

// أبعاد زوجية مع حد أقصى 1920x1080
function evenCap(n, cap) {
  return Math.max(2, Math.floor(Math.min(n, cap) / 2) * 2);
}

// بناء أمر الدمج الكامل: فلتر توحيد لكل مصدر ثم concat مع مسار صامت للمصادر بلا صوت
function buildMergeArgs({ inputPaths, probes, outPath, preset }) {
  const maxW = evenCap(Math.max(...probes.map((p) => p.width)), 1920);
  const maxH = evenCap(Math.max(...probes.map((p) => p.height)), 1080);
  const args = ["-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-stats_period", "1"];

  // مدخلات الفيديو + مدخل anullsrc لكل مصدر بلا صوت
  const silentInputs = [];
  inputPaths.forEach((p, i) => {
    args.push("-i", p);
    if (!probes[i].hasAudio) silentInputs.push(i);
  });
  silentInputs.forEach((i) => {
    args.push("-f", "lavfi", "-t", String(probes[i].duration.toFixed(3)), "-i", "anullsrc=r=44100:cl=stereo");
  });

  // filter_complex: scale+pad إلى أكبر دقة، fps=30، setsar=1، yuv420p
  const filters = [];
  let silentIdx = inputPaths.length;
  inputPaths.forEach((_, i) => {
    filters.push(
      `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (probes[i].hasAudio) {
      filters.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      // المصدر بلا صوت — نستخدم مسارًا صامتًا بنفس مدته بدل أن يفشل الدمج
      filters.push(`[${silentIdx}:a]aresample=44100[a${i}]`);
      silentIdx++;
    }
  });
  // مدخلات concat موسومة بالترتيب: [v0][a0][v1][a1]…
  const concatInputs = inputPaths.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${concatInputs}concat=n=${inputPaths.length}:v=1:a=1[vout][aout]`);

  args.push("-filter_complex", filters.join("; "));
  args.push("-map", "[vout]", "-map", "[aout]");
  args.push("-c:v", "libx264", "-crf", "18", "-preset", preset || FFMPEG_PRESET);
  args.push("-c:a", "aac", "-b:a", "192k", "-ar", "44100");
  args.push("-movflags", "+faststart");
  args.push("-progress", "pipe:1", "-nostats");
  args.push(outPath);
  return { args, width: maxW, height: maxH };
}

// تشغيل ffmpeg مع قراءة التقدم من -progress pipe:1 (out_time_us) — onProgress(percent)
function runFfmpegWithProgress(bin, args, totalDuration, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuf = "";
    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && totalDuration > 0) {
          const pct = Math.min(99, Math.max(0, Math.round((Number(m[1]) / 1e6 / totalDuration) * 100)));
          if (onProgress) onProgress(pct);
        }
      }
    });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`فشل ترميز ffmpeg: ${stderr.slice(-600)}`))));
  });
}

module.exports = { resolveFfmpeg, resolveFfprobe, probeFile, buildMergeArgs, runFfmpegWithProgress, evenCap };
