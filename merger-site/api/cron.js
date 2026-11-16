// GET /api/cron — حذف المهام المنتهية (مجدول يوميًا عبر vercel.json crons)
const { setCors, json, methodNotAllowed, noContent } = require("../lib/http");
const { cleanupExpired } = require("../lib/db");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  // نقبل GET وPOST لأن مزودات الجدولة تختلف
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  try {
    const deleted = await cleanupExpired();
    return json(res, 200, { ok: true, deleted });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
