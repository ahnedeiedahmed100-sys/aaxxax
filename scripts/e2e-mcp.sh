#!/usr/bin/env bash
# اختبار e2e كامل لتدفق التوليد مع التبديل التسلسلي — يُشغّل خادم المحاكاة داخل الجلسة نفسها
# (العمليات الخلفية لا تبقى بين النداءات في بيئة الغرفة المعزولة فنشغّل كل شيء دفعة واحدة)
set -u
cd /home/z/my-project

echo "===== 1) تشغيل خادم محاكاة kie.ai ====="
node scripts/mock-kie.mjs > /tmp/mock-kie.log 2>&1 &
MOCK_PID=$!
sleep 1.2
curl -s http://127.0.0.1:9099/api/v1/jobs/recordInfo?taskId=probe -o /dev/null -w "mock alive=%{http_code}\n"

echo "===== 2) توليد صورة (معيار القبول 4 + التبديل التسلسلي 6/7) ====="
IMG=$(curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"قطة فضائية ترتدي خوذة زجاجية تحلق فوق السحاب","aspect_ratio":"1:1"}}}')
echo "$IMG" | head -c 600; echo

echo "===== 3) توليد فيديو بنافذة قصيرة (معيار القبول 5: task_id ثم get_task) ====="
VID=$(curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"generate_video","arguments":{"prompt":"رجل يفتح مظارته تحت المطر ويقول: أخيرًا وصلت","duration":6,"wait_seconds":5}}}')
echo "$VID" | head -c 400; echo
TASK_ID=$(echo "$VID" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'data: (\{.*\})', raw)
if not m:
    print(''); sys.exit()
d = json.loads(m.group(1))
text = d.get('result', {}).get('content', [{}])[0].get('text', '')
mm = re.search(r'task_id: ([0-9a-f\-]+)', text)
print(mm.group(1) if mm else '')
")
echo "استخرجنا task_id: ${TASK_ID:-<فارغ>}"

if [ -n "$TASK_ID" ]; then
  echo "===== 4) استعلام get_task كل 3 ثوانٍ حتى الاكتمال ====="
  for i in $(seq 1 12); do
    sleep 3
    R=$(curl -s -X POST http://localhost:3000/mcp \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":13,\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$TASK_ID\"}}}")
    TXT=$(echo "$R" | python3 -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'data: (\{.*\})', raw)
if not m: print('<no data>'); sys.exit()
d = json.loads(m.group(1))
print(d.get('result', {}).get('content', [{}])[0].get('text', '')[:220])
")
    echo "[poll $i] $TXT"
    if echo "$TXT" | rg -q "✅"; then echo ">>> اكتمل الفيديو"; break; fi
  done
fi

echo "===== 5) حالة المفاتيح بعد الاختبارات (معيار 6 و7) ====="
curl -s http://localhost:3000/api/keys | python3 -c "
import json, sys
for k in json.load(sys.stdin)['keys']:
    print(f\"{k['label']}: status={k['status']} usage={k['usageCount']} success={k['successCount']} fail={k['failCount']} lastErr={(k['lastError'] or '')[:45]}\")
"

echo "===== 6) محاولات آخر مهمة صورة (الترتيب والتصنيف) ====="
curl -s "http://localhost:3000/api/tasks?limit=5" | python3 -c "
import json, sys
ts = json.load(sys.stdin)['tasks']
img = next((t for t in ts if t['type'] == 'image' and t['attempts']), None)
if img:
    print('image task:', img['id'][:8], img['status'])
    for a in img['attempts']:
        print('  -', a.get('keyLabel'), '| ok=', a.get('ok'), '| cls=', a.get('errorClass'), '| err=', (a.get('error') or '')[:40])
    print('resultUrls:', img.get('resultUrls'))
"

kill $MOCK_PID 2>/dev/null
echo "===== انتهى ====="
