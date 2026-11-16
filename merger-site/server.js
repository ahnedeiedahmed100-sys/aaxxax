// خادم تطوير محلي يحاكي بيئة Vercel: يحمّل .env يدويًا، يحلّل المسارات الديناميكية
// ويضعها في req.query تمامًا كما تفعل Vercel، ويخدم الواجهة الثابتة من public/.
// التشغيل: node server.js (المنفذ الافتراضي 3001)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const url = require("node:url");
const { setCors, fail } = require("./lib/http");

// (1) تحميل .env يدويًا — لا اعتماد على مكتبات خارجية
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = parseInt(process.env.PORT || "3001", 10);

// (2) جدول المسارات — يحاكي قواعد Vercel: ملف [param] يضع قيمته في req.query
const routes = [
  { method: "POST", pattern: /^\/api\/jobs\/([^/]+)\/process$/, file: path.join(__dirname, "api/jobs/[id]/process.js"), param: "id" },
  { method: "GET", pattern: /^\/api\/jobs\/([^/]+)\/video$/, file: path.join(__dirname, "api/jobs/[id]/video.js"), param: "id" },
  { method: "GET", pattern: /^\/api\/jobs\/([^/]+)$/, file: path.join(__dirname, "api/jobs/[id].js"), param: "id" },
  { method: "DELETE", pattern: /^\/api\/jobs\/([^/]+)$/, file: path.join(__dirname, "api/jobs/[id].js"), param: "id" },
  { method: "POST", pattern: /^\/api\/jobs\/?$/, file: path.join(__dirname, "api/jobs.js") },
  { method: "POST", pattern: /^\/api\/upload\/?$/, file: path.join(__dirname, "api/upload.js") },
  { method: "GET", pattern: /^\/api\/config\/?$/, file: path.join(__dirname, "api/config.js") },
  { method: "GET", pattern: /^\/api\/cron\/?$/, file: path.join(__dirname, "api/cron.js") },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  req.query = { ...parsed.query }; // المتغيرات الديناميكية تُضاف لاحقًا هنا

  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

  // (3) نقاط الـ API
  for (const r of routes) {
    if (req.method !== r.method) continue;
    const m = r.pattern.exec(parsed.pathname);
    if (!m) continue;
    if (r.param) req.query[r.param] = decodeURIComponent(m[1]);
    try {
      delete require.cache[require.resolve(r.file)]; // إعادة تحميل في التطوير
      const handler = require(r.file);
      await handler(req, res);
    } catch (e) {
      console.error("[server]", req.method, parsed.pathname, e);
      if (!res.headersSent) fail(res, 500, e.message || "خطأ داخلي في الخادم");
    }
    return;
  }

  // (4) الواجهة الثابتة
  let filePath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const abs = path.normalize(path.join(__dirname, "public", filePath));
  if (abs.startsWith(path.join(__dirname, "public")) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    res.setHeader("Content-Type", MIME[path.extname(abs)] || "application/octet-stream");
    fs.createReadStream(abs).pipe(res);
    return;
  }

  fail(res, 404, "المسار غير موجود");
});

server.listen(PORT, () => {
  console.log(`[video-merger] خادم التطوير يعمل على http://localhost:${PORT}`);
});
