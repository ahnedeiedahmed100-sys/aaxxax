# خدمة دمج الفيديو — Video Merger API v2

موقع كامل لدمج الفيديوهات مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على Vercel — Node.js خالص (CommonJS) بدون Next.js أو أي خطوة بناء.

- **الواجهة**: عربية RTL بثيم داكن حديث — سحب وإفلات لرفع الملفات، روابط مباشرة، إعادة ترتيب المصادر، شريط تقدم حقيقي، صفحة نتيجة بمشغل وعدّاد صلاحية 24 ساعة، وقسم توثيق API قابل للطي.
- **API عامة**: بلا تسجيل دخول، CORS مفتوح، الأخطاء بصيغة `{"error":"..."}` برسائل عربية.
- **المخرجات**: MP4 (H.264 CRF 18 + AAC 192k/44100Hz + +faststart) — توحيد كل المصادر إلى أكبر دقة (حد أقصى 1920×1080 أبعاد زوجية)، fps=30، ومصدر بلا صوت يُكمل بمسار صامت `anullsrc` بدل أن يفشل الدمج.

## الحدود العامة

| الحد | القيمة | قابل للضبط بمتغير |
|---|---|---|
| عدد المقاطع | 10 كحد أقصى | `MAX_SOURCES` |
| حجم كل مصدر | 200MB | `SOURCE_MAX_MB` |
| حجم الناتج | 150MB | `OUTPUT_MAX_MB` |
| مجموع المدد | 600 ثانية | `MAX_TOTAL_DURATION_SEC` |
| صلاحية الملفات | تُحذف تلقائيًا بعد 24 ساعة | — |
| حجم جزء الرفع | 4MB (حد Vercel ≈ 4.5MB) | `uploadChunkBytes` في config |

## نقاط النهاية

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء الملفات (ثنائي ≤4MB) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط الفيديو النهائي |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم (0–100) + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم Range، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل (jobs + sources + chunks) |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي عبر vercel.json) |

### أمثلة curl

```bash
# 1) إنشاء مهمة من روابط مباشرة
curl -X POST https://<domain>/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
# ← 201: {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# 2) تنفيذ الدمج (متزامن ~10–60 ثانية)
curl -X POST https://<domain>/api/jobs/<jobId>/process
# ← 200: {"status":"done","videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"WxH","expiresAt":"..."}
# لو قيد المعالجة فعله → 202

# 3) متابعة الحالة
curl https://<domain>/api/jobs/<jobId>
# ← {"status":"queued|processing|done|failed","progress":0..100,"videoUrl":"...","error":"..."}

# 4) تحميل/بث الناتج (يدعم Range ليعمل التقديم في المشغل)
curl -H "Range: bytes=0-1023" -o part.mp4 https://<domain>/api/jobs/<jobId>/video   # ← 206
curl -o final.mp4 "https://<domain>/api/jobs/<jobId>/video?download=1"

# 5) رفع ملف من الجهاز على أجزاء 4MB
curl -X POST "https://<domain>/api/upload?job=<jobId>&seq=0&chunk=0" \
  -H 'Content-Type: application/octet-stream' --data-binary @chunk0.bin
# ← 200: {"ok":true,"received":4194304}

# 6) الحدود العامة
curl https://<domain>/api/config

# 7) حذف فوري
curl -X DELETE https://<domain>/api/jobs/<jobId>
```

**حالات المهمة**: `queued` → (`uploading` عند وجود ملفات) → `processing` → `done` | `failed`، مع عمود `progress` (0–40 سحب المصادر، 40–90 ترميز ffmpeg، 100 اكتمال).

**أكواد الرفض**: 400 لمدخلات تالفة، 404 لغير الموجود، 409 لحالة غير مناسبة، 413 لتجاوز الحجم، 405 لطريقة خاطئة — كلها برسائل عربية واضحة.

## خطوات إنشاء قاعدة Turso والحصول على التوكن

```bash
# 1) ثبّت Turso CLI: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup                       # أو turso auth login
turso db create video-merger            # خطة مجانية تكفي
turso db show video-merger --url        # ← انسخ الرابط (TURSO_DATABASE_URL)
turso db tokens create video-merger     # ← انسخ التوكن (TURSO_AUTH_TOKEN)
```

## خطوات النشر على Vercel

1. ارفع مجلد `merger-site/` إلى مستودع GitHub خاص به (أو كمجلد فرعي واختر Root Directory = `merger-site` عند الاستيراد).
2. في Vercel: **Add New → Project → Import** المستودع.
3. **Settings → Environment Variables** أضف:

   | المتغير | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://video-merger-<org>.turso.io` |
   | `TURSO_AUTH_TOKEN` | التوكن من `turso db tokens create` |

   متغيرات اختيارية للضبط: `MAX_SOURCES=10`, `SOURCE_MAX_MB=200`, `OUTPUT_MAX_MB=150`, `MAX_TOTAL_DURATION_SEC=600`, `FFMPEG_PRESET=medium`, `FFMPEG_BIN`, `FFPROBE_BIN`.
4. **Deploy**. ملف `vercel.json` مضبوط مسبقًا: `maxDuration: 300` لكل الدوال + Cron يومي على `/api/cron` للتنظيف.
5. انسخ رابط النشر (`https://<project>.vercel.app`) وضَعه في `MERGER_API_BASE` للمشروع الرئيسي (خادم MCP).

> ملاحظات تقنية: ثنائي ffmpeg من `ffmpeg-static`/`ffprobe-static` — الدالة تضمن صلاحيته بـ chmod 755 في `/tmp` عند الحاجة. لا يعتمد على ملفات دائمة: `/tmp` أثناء المعالجة فقط ويُنظف في `finally`. Blobs القاعدة مقسمة صفوف 2MB (حد Turso) وتقرأ تدفقيًا صفحات 8 صفوف؛ بعد نجاح الدمج تُحذف source_chunks ويبقى الناتج فقط حتى الحذف/انتهاء الصلاحية.

## التشغيل المحلي والاختبار

```bash
npm install
cp .env.example .env       # ثم اضبط TURSO_DATABASE_URL أو اتركه فارغًا؟ — مطلوب؛ محليًا يمكن file:./db/local.db
node server.js             # http://localhost:3001

npm run test:unit          # 13 اختبار: توليد مقطعين بffmpeg ودمجهما والتحقق من الدقة/المدة/الصوت/التخزين/الرفع/الحدود/الحذف
npm run test:http          # 21 اختبار: روابط → دمج → Range 206 → مهمة مختلطة → حذف → 404 → JSON تالف → الحدود
```

## حدود الخطة المجانية التي يجب معرفتها

- **Vercel Hobby**: مدة الدالة حتى 300 ثانية (مضبوطة `maxDuration`)، حجم الطلب ≈ 4.5MB (لهذا الرفع على أجزاء 4MB)، تنفيذ واحد متزامن للدوال الثقيلة أفضل، لا ملفات دائمة (لذلك كل شيء في Turso + /tmp).
- **Turso Free**: حتى 500 قاعدة، تخزين ≈ 5GB، وعدد صفوف/استعلامات شهري سخي للتطوير — Blobs الناتج تُحذف بعد 24 ساعة فلا تتراكم.
- الدمج يتطلب سحب المصادر من الروابط داخل الدالة: استخدم روابط عامة سريعة؛ مصدر يرفض التحميل (HTTP 403) = فشل حتمي للمهمة.
