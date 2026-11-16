// الحدود العامة للخدمة — كلها قابلة للضبط عبر متغيرات البيئة (الافتراضيات وفق المواصفة)
module.exports = {
  MAX_SOURCES: parseInt(process.env.MAX_SOURCES || "10", 10),        // أقصى عدد مقاطع للدمج
  SOURCE_MAX_MB: parseInt(process.env.SOURCE_MAX_MB || "200", 10),   // أقصى حجم لمصدر واحد
  OUTPUT_MAX_MB: parseInt(process.env.OUTPUT_MAX_MB || "150", 10),   // أقصى حجم للناتج
  MAX_TOTAL_DURATION_SEC: parseInt(process.env.MAX_TOTAL_DURATION_SEC || "600", 10), // مجموع المدد
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024, // أقصى جسم لطلب رفع واحد (يتناسب مع حد Vercel ≈ 4.5MB)
  BLOB_ROW_BYTES: 2 * 1024 * 1024,     // حجم صف الـ Blob في Turso (أقل من حد HTTP للقيمة الواحدة)
  READ_PAGE_ROWS: 8,                   // عدد صفوف الـ Blob لكل صفحة قراءة تدفقية
  EXPIRY_HOURS: 24,                    // مدة بقاء الملفات قبل الحذف التلقائي
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  VERSION: "1.0.0",
};
