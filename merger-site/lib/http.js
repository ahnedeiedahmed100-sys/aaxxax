// أدوات HTTP المشتركة: CORS مفتوح، استجابات JSON، وأخطاء بصيغة موحدة {"error":"..."}
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");
}

function noContent(res) {
  res.statusCode = 204;
  res.end(); // 204 بلا جسم
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

// رد موحد لطريقة HTTP خاطئة
function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  fail(res, 405, "طريقة HTTP غير مدعومة لهذه النقطة");
}

// بناء العنوان الأساسي للروابط المطلقة من ترويسات الطلب
// على Vercel توجد x-forwarded-proto دائمًا (https) — محليًا بلا ترويسة نعتمد اتصال المقبس الفعلي
function baseUrlFromReq(req) {
  const proto = (req.headers["x-forwarded-proto"]
    || (req.socket && req.socket.encrypted ? "https" : "http")).toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "localhost").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

// قراءة الجسم الثنائي الخام بالكامل مع حد أقصى (لنقطة الرفع)
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error(`حجم الجزء يتجاوز الحد المسموح (${Math.floor(maxBytes / (1024 * 1024))}MB)`), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// قراءة جسم JSON مع قبول الأخطاء بصيغة عربية واضحة
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return readRawBody(req, maxBytes).then((buf) => {
    const text = buf.toString("utf8").trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      const e = new Error("جسم الطلب ليس JSON صالحًا");
      e.code = 400;
      throw e;
    }
  });
}

module.exports = { setCors, json, fail, noContent, methodNotAllowed, baseUrlFromReq, readRawBody, readJsonBody };
