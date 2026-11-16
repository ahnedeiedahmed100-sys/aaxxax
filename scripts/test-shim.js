// اختبار جسر Node res وهمي: هل assignSocket يقبل Duplex؟ وهل نقرأ ترويسات HTTP الخام؟
const { Duplex } = require("node:stream");
const { ServerResponse, IncomingMessage } = require("node:http");
const net = require("node:net");

const req = new IncomingMessage();
req.method = "POST"; req.url = "/mcp"; req.headers = { "content-type": "application/json" };

const socket = new Duplex({ read() {}, write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
const chunks = [];
try {
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write("event: message\ndata: {\"a\":1}\n\n");
  res.end();
  res.on("finish", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    console.log("RAW OUTPUT >>>");
    console.log(JSON.stringify(raw));
  });
} catch (e) {
  console.error("assignSocket FAILED:", e.message);
}
