#!/usr/bin/env bash
# اختبار الدمج الحقيقي عبر MCP مع خدمة الدمج الفعلية (معيار القبول 8 و9)
set -u

echo "===== merge_videos بمقطعين عامين عبر MCP ====="
MERGE=$(curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"merge_videos","arguments":{"urls":["https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4","https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4"],"wait_seconds":90}}}')
TXT=$(echo "$MERGE" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'data: (\{.*\})', raw)
if not m: print(raw[:300]); sys.exit()
d = json.loads(m.group(1))
print(d.get('result', {}).get('content', [{}])[0].get('text', ''))
")
echo "$TXT"
MERGE_TASK_ID=$(echo "$TXT" | python3 -c "
import sys, re
mm = re.search(r'task_id: ([0-9a-f\-]+)', sys.stdin.read())
print(mm.group(1) if mm else '')
")
echo "merge task_id: ${MERGE_TASK_ID:-<مكتمل مباشرة>}"

# إن أعاد task_id نتابعه بـ get_task
if [ -n "$MERGE_TASK_ID" ]; then
  for i in $(seq 1 30); do
    sleep 3
    R=$(curl -s -X POST http://localhost:3000/mcp \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":21,\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$MERGE_TASK_ID\"}}}")
    TXT=$(echo "$R" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'data: (\{.*\})', raw)
if not m: print('<no data>'); sys.exit()
d = json.loads(m.group(1))
print(d.get('result', {}).get('content', [{}])[0].get('text', '')[:260])
")
    echo "[poll $i] $TXT" | tr '\n' ' '; echo
    if echo "$TXT" | rg -q "✅|❌"; then break; fi
  done
fi

echo "===== التحقق من رابط الفيديو الناتج (نطاق الدمج + تشغيل + Range) ====="
VID_URL=$(echo "$TXT" | rg -o 'https://[^ ]+' | head -1)
echo "videoUrl: ${VID_URL:-<none>}"
if [ -n "${VID_URL:-}" ]; then
  curl -s -o /dev/null -w "GET status=%{http_code} type=%{content_type} size=%{size_download}\n" "$VID_URL" --max-time 20 -r 0-1023
  curl -s -o /dev/null -w "Range status=%{http_code}\n" "$VID_URL" --max-time 20 -H "Range: bytes=0-99"
fi
echo "===== انتهى اختبار الدمج ====="
