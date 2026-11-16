// سجل الموديلات — الأسماء الكانونية والبدائل (شرطات/نقاط) وأسماء الموديل لكل مزود.
// الأسماء قابلة للتجاوز بمتغيرات البيئة: KIE_IMAGE_MODEL / KIE_VIDEO_MODEL / COMETAPI_IMAGE_MODEL / COMETAPI_VIDEO_MODEL
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحه كلها بالترتيب
  providerModel: Record<ProviderId, string>;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: env("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: env("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: env("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: env("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      cometapi: env("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

// توحيد اسم الموديل: نقبل الصيغ بالنقاط ونحوّلها إلى الكانوني
export function normalizeModelName(input: string): ModelDef | null {
  const clean = input.trim();
  for (const m of MODELS) {
    if (m.canonical === clean || m.aliases.includes(clean)) return m;
    // نقبل أيضًا الشكل بالنقاط والشرطات بالتناوب (2.6 ↔ 2-6)
    const dotted = m.canonical.replace(/-/g, ".");
    if (dotted === clean.replace(/-/g, ".")) return m;
  }
  return null;
}

export function modelByType(type: MediaType): ModelDef | null {
  return MODELS.find((m) => m.type === type) || null;
}
