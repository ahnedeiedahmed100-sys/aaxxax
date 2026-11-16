# MCP Media Generator — خادم MCP لتوليد الوسائط بالذكاء الاصطناعي

خادم MCP يجمع ثلاث قدرات في أداة واحدة: **توليد صور** من وصف نصي، **توليد فيديو** بصوت متزامن أصلي، و**دمج عدة مقاطع** في فيديو واحد — مع **لوحة إدارة عربية RTL** لإدارة المفاتيح ومتابعة المهام حيًا.

- توليد الصور: `gpt-image-2-6/flare-text-to-image`
- توليد الفيديو: `grok-imagine-video-1-5-preview`
- الدمج: عبر خدمة دمج منفصلة (مجلد `merger-site/` في هذا المستودع، أو أي خدمة متوافقة)

## الفكرة الجوهرية

- **روابط فقط**: لا يُنزَّل أي ملف وسائط على السيرفر — نخزّن روابط النتائج فقط.
- **مفاتيح متعددة بتبديل تسلسلي صارم**: أول مفتاح أُضيف يُجرَّب أولًا ثم التالي ثم التالي (ليس round-robin). عند أي خطأ (مفتاح مرفوض، رصيد مستنزف، 429، خطأ شبكة) ينتقل السيرفر **فورًا وصامتة** للمفتاح التالي ويستأنف **نفس المهمة بنفس task_id** — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
- **مهمة فشلت على كل المفاتيح تبقى «جارية»** («بانتظار توفر مفتاح صالح…») وتُعاد محاولتها تلقائيًا مع كل استدعاء `get_task` بتهدئة 45 ثانية — لو شُحن رصيد أي مفتاح اكتملت المهمة من تلقاء نفسها.
- **التوليد غير متزامن**: الأداة تعيد `task_id` فورًا مع نافذة انتقال قصيرة تبث تقدمًا حيًا (Progress notifications كل ~3 ثوانٍ)، والعميل يتابع بأداة `get_task` كل ~10 ثوانٍ.
- **إخفاء المفاتيح إلزامي**: كل الاستجابات تعرض المفتاح مُقنَّعًا (`ABCD123••••••••WXYZ`) ولا يعاد المفتاح الكامل في أي مسار.

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة بمعطيات: prompt، aspect_ratio، resolution (1K/2K/4K)، background، output_format، wait_seconds |
| `generate_video` | توليد فيديو بصوت متزامن: prompt، image_url اختياري (image-to-video)، aspect_ratio، resolution، duration، enable_audio، wait_seconds |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب: `urls` روابط مباشرة أو `task_ids` لمهام فيديو مكتملة (تُحل من قاعدة البيانات بالترتيب) — الناتج يُحذف من خدمة الدمج بعد ~24 ساعة |
| `get_task` | تتبع أي مهمة بمعرّفها (توليد أو دمج) — يستعلم المزود/خدمة الدمج حيًا ويطبق منطق التبديل نفسه |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها من قاعدة البيانات دون إعادة توليد |

نتائج الأدوات تُصاغ بالعربية، وأسماء الأدوات والمصطلحات التقنية تبقى بالإنجليزية.

## البنية

```
src/
  app/mcp/route.ts             # خادم MCP (Streamable HTTP عبر SDK الرسمي، نمط stateless)
  app/api/health/route.ts      # الجهوزية: قاعدة البيانات + الموديلات + خدمة الدمج
  app/api/keys/route.ts        # إدارة المفاتيح: GET (مقنَّع دائمًا) + POST (رفض تكرار)
  app/api/keys/[id]/route.ts   # تعطيل/تنشيط/حذف
  app/api/tasks/route.ts       # لوحة المهام: الإحصائيات + أحدث المهام
  app/page.tsx                 # الواجهة العربية RTL (ثلاث بطاقات)
  lib/turso.ts                 # عميل Turso (libSQL عبر HTTP) + ensureSchema + فحص الجهوزية
  lib/keys.ts                  # مجمّع المفاتيح التسلسلي + تصنيف الأخطاء + القناع + العدادات
  lib/models.ts                # سجل الموديلات (أسماء كانونية + بدائل بالنقاط + اسم لكل مزود)
  lib/generation.ts            # منسق التوليد runGeneration/refreshTask مع التبديل التسلسلي
  lib/merge.ts                 # تدفق الدمج runMerge/refreshMergeTask (قفل process مرة واحدة)
  lib/merger.ts                # عميل خدمة الدمج v2 (تحليل دفاعي للحالة)
  lib/providers/               # واجهة المزودات: kie.ts (Jobs API) + cometapi.ts (صور متزامنة/فيديو)
scripts/
  mock-kie.mjs                 # محاكاة kie.ai للاختبار المحلي فقط (أشكال المواصفة الحقيقية)
  e2e-mcp.sh                   # اختبار e2e كامل للتبديل التسلسلي (مفاتيح سيئ/مستنزف/محدود/صالح)
  e2e-merge.sh                 # اختبار e2e حقيقي للدمج بمقطعين عامين
merger-site/                   # موقع خدمة دمج الفيديو (مشروع مستقل — راجع merger-site/README.md)
```

## التشغيل المحلي

```bash
# 1) تبعيات المشروع الرئيسي
npm install        # أو bun install

# 2) خدمة الدمج المحلية (منفذ 3001)
cd merger-site && npm install && node server.js &

# 3) انسخ .env.example إلى .env.local واضبط ما يلزم (راجع الجدول أدناه)

# 4) شغّل التطبيق
npm run dev        # http://localhost:3000
```

بدون `TURSO_DATABASE_URL` يعمل التطبيق على **ملف محلي للتطوير فقط** (`data/mcp.db`) وتظهر شارة «قاعدة محلية (وضع التطوير)» في الواجهة — على الإنتاج استخدم Turso دائمًا.

## متغيرات البيئة

| المتغير | إلزامي؟ | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم على الإنتاج | رابط قاعدة Turso عبر HTTP (مثل `libsql://db-name-org.turso.io`) |
| `TURSO_AUTH_TOKEN` | نعم على الإنتاج | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | نعم | عنوان خدمة الدمج (منشورة على Vercel من مجلد `merger-site/`) |
| `MCP_ACCESS_TOKEN` | اختياري | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` ويظهر ذلك في الواجهة و health |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | اختياري | تجاوز أسماء موديلات kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | اختياري | تجاوز أسماء موديلات CometAPI |
| `KIE_API_BASE` / `COMETAPI_BASE_URL` | اختياري (اختبار) | تجاوز عناوين المزودين — لأغراض المحاكاة المحلية فقط |

**`.env*` مستثناة من Git منذ اليوم الأول — لا ترفع أي سر إطلاقًا ولا تُطبع مفاتيح كاملة في السجلات.**

## إنشاء قاعدة Turso المجانية

```bash
# ثبّت Turso CLI ثم:
turso db create media-gen
turso db show media-gen --url          # ← TURSO_DATABASE_URL
turso db tokens create media-gen       # ← TURSO_AUTH_TOKEN
```

## النشر على Vercel (المشروع الرئيسي)

1. ارفع المستودع إلى GitHub (بلا أي ملف `.env`).
2. في Vercel: Import Project → اختر المستودع (جذر المستودع للمشروع الرئيسي).
3. أضف متغيرات البيئة الثلاثة الإلزامية: `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` و `MERGER_API_BASE`.
4. Deploy. كل شيء يعمل لأن libSQL يتصل عبر HTTP ومناسب للـ serverless، ومسار `/mcp` يدعم البث التدفقي.
5. انشر مجلد `merger-site/` كمشروع Vercel منفصل وضَع رابطه في `MERGER_API_BASE`.

## ربط السيرفر بأي عميل MCP

انسخ الرابط `<origin>/mcp` من بطاقة «ربط السيرفر» في الواجهة:

- **ChatGPT / GPT Agents**: Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
- **Claude Desktop** (`claude_desktop_config.json`):
  ```json
  { "mcpServers": { "media-generator": { "type": "http", "url": "https://<domain>/mcp" } } }
  ```
- **Cursor / Windsurf / Cline** (`mcp.json`):
  ```json
  { "mcpServers": { "media-generator": { "url": "https://<domain>/mcp" } } }
  ```

## الاختبار المحلي

```bash
# اختبار e2e كامل للتبديل التسلسلي (يشغّل محاكاة kie.ai داخل الجلسة):
bash scripts/e2e-mcp.sh

# اختبار الاتصال بقاعدة Turso الحقيقية (يقرأ .env.local وينشئ الجداول ويكتب/يقرأ/يحذف صفًا تجريبيًا):
node --env-file=.env.local scripts/test-turso.js

# اختبار دمج حقيقي بمقطعين عامين (يتطلب خدمة الدمج على 3001):
bash scripts/e2e-merge.sh

# اختبارات خدمة الدمج نفسها:
cd merger-site && npm run test:unit && npm run test:http
```

## ملاحظات تشغيلية

- نمط `/mcp` هنا **stateless** (بلا جلسات في الذاكرة) — الأنسب لبيئات serverless مثل Vercel؛ كل عميل MCP متوافق يعمل معه مباشرة.
- مهمة الدمج تنفَّذ `process` مرة واحدة فقط لكل مهمة (قفل في الذاكرة) حتى لو استدعي `get_task` بالتزامن.
- أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx بجسم error) = فشل حتمي فوري؛ أخطاء شبكتنا نحن = مؤقتة وتستمر بالاستعلام حتى انتهاء النافذة.
