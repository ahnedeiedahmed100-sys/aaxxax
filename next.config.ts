import type { NextConfig } from "next";

// الإخراج standalone للنشر (Vercel/دوكر) — والتحقق من TypeScript مفعل أثناء البناء (tsc --noEmit نظيف)
const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@libsql/client"],
  reactStrictMode: false,
};

export default nextConfig;
