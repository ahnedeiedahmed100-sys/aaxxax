#!/usr/bin/env node
// خادم محاكاة kie.ai للاختبار المحلي فقط — لا يُستخدم في الإنتاج أبدًا.
// يطابق الأشكال الحقيقية المقاسة والموثقة في المواصفة (Jobs API الموحد):
//   POST /api/v1/jobs/createTask  Authorization: Bearer <key>
//     → {"code":200,"data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo?taskId=
//     → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//         "resultJson":"{\"resultUrls\":[\"https://...\"]}", "failMsg":"..."}}
// سلوك المفاتيح حسب محتواها (لتغطية معايير القبول 4–7):
//   BAD      → HTTP 401 invalid api key            (مفتاح مرفوض → disabled تلقائيًا)
//   EXHAUSTED→ HTTP 402 insufficient balance        (مستنزف → exhausted ويبقى في القاعدة)
//   RATE     → HTTP 429 rate limit exceeded         (مؤقت → انتقل للتالي دون تعليم)
//   SERVICE  → HTTP 500 provider crashed            (مؤقت 5xx)
//   غير ذلك  → مفتاح صالح: waiting→generating→success
// سرعة التقدم: الصور ~6 ثوانٍ، الفيديو ~14 ثانية (يتجاوز نافذة wait_seconds=5 لاختبار get_task).
import http from "node:http";

const PORT = Number(process.env.MOCK_KIE_PORT || 9099);
const tasks = new Map(); // taskId → { kind: "image"|"video", createdAt }
let seq = 0;

function classifyKey(key) {
  if (/BAD/.test(key)) return "bad";
  if (/EXHAUSTED/.test(key)) return "exhausted";
  if (/RATE/.test(key)) return "rate";
  if (/SERVICE/.test(key)) return "service";
  return "valid";
}

const server = http.createServer((req, res) => {
  const key = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const kind = classifyKey(key);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const sendJson = (status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  // أخطاء المفاتيح — أشكال حقيقية مع الحالة المقابلة
  if (kind === "bad") return sendJson(401, { code: 401, msg: "invalid api key" });
  if (kind === "exhausted") return sendJson(402, { code: 402, msg: "insufficient balance, please recharge" });
  if (kind === "rate") return sendJson(429, { code: 429, msg: "rate limit exceeded" });
  if (kind === "service") return sendJson(500, { code: 500, msg: "provider internal error" });

  if (url.pathname === "/api/v1/jobs/createTask" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* تجاهل */ }
      const isVideo = String(parsed.model || "").includes("video");
      const taskId = `mock-task-${++seq}-${isVideo ? "video" : "image"}`;
      tasks.set(taskId, { kind: isVideo ? "video" : "image", createdAt: Date.now() });
      sendJson(200, { code: 200, data: { taskId } });
    });
    return;
  }

  if (url.pathname === "/api/v1/jobs/recordInfo" && req.method === "GET") {
    const taskId = url.searchParams.get("taskId") || "";
    const t = tasks.get(taskId);
    if (!t) return sendJson(404, { code: 404, msg: "task not found" });
    const elapsed = (Date.now() - t.createdAt) / 1000;
    const needSec = t.kind === "video" ? 14 : 6;
    if (elapsed < needSec) {
      const state = elapsed < 1.5 ? "waiting" : elapsed < 3 ? "queuing" : "generating";
      return sendJson(200, { code: 200, data: { state } });
    }
    // نجاح — resultJson نص JSON داخل JSON كما في المواصفة
    const inner = { resultUrls: [`https://mock-cdn.kie.local/${t.kind}/${taskId}.${t.kind === "video" ? "mp4" : "png"}`] };
    return sendJson(200, { code: 200, data: { state: "success", resultJson: JSON.stringify(inner) } });
  }

  sendJson(404, { code: 404, msg: "not found" });
});

server.listen(PORT, () => console.log(`[mock-kie] يعمل على http://localhost:${PORT} — للاختبار فقط`));
