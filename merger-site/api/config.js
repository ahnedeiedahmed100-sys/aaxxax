// GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية)
const { setCors, json, methodNotAllowed, noContent } = require("../lib/http");
const { MAX_SOURCES, SOURCE_MAX_MB, OUTPUT_MAX_MB, MAX_TOTAL_DURATION_SEC, UPLOAD_CHUNK_BYTES, EXPIRY_HOURS, VERSION } = require("../lib/limits");
const { dbHealthy } = require("../lib/db");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  return json(res, 200, {
    version: VERSION,
    healthy: true,
    limits: {
      maxSources: MAX_SOURCES,
      sourceMaxMB: SOURCE_MAX_MB,
      outputMaxMB: OUTPUT_MAX_MB,
      maxTotalDurationSec: MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: UPLOAD_CHUNK_BYTES,
      expiryHours: EXPIRY_HOURS,
    },
    database: (await dbHealthy()) ? "connected" : "unavailable",
  });
};
