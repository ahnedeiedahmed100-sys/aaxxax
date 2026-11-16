"use client";

// لوحة الإدارة العربية RTL — صفحة واحدة بثلاث بطاقات:
// أ) مدير المفاتيح، ب) لوحة المهام (تحديث تلقائي كل 5 ثوانٍ)، ج) ربط السيرفر (JSON جاهز للنسخ).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Copy, KeyRound, Plus, RefreshCw, Trash2, Activity, ServerCog, Link2, CheckCircle2, XCircle, Timer, ExternalLink } from "lucide-react";

// ---------- أنواع البيانات ----------
interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}
interface SafeKey {
  id: string; provider: string; label: string; status: string;
  usageCount: number; successCount: number; failCount: number;
  lastUsedAt: string | null; lastError: string | null;
  createdAt: string; masked: string;
}
interface TaskItem {
  id: string; provider: string | null; model: string; type: string;
  prompt: string; status: string; progress: number;
  resultUrls: string[] | null; errorMessage: string | null;
  attempts: unknown[]; createdAt: string; completedAt: string | null;
}
interface Stats { total: number; completed: number; failed: number; processing: number; }

const STATUS_LABEL: Record<string, string> = {
  active: "نشط", exhausted: "مستنزف", disabled: "معطّل",
  completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "بالانتظار",
  image: "صورة", video: "فيديو", merge: "دمج",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try { return new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z")).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" }); } catch { return iso; }
}

export default function Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<SafeKey[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [origin, setOrigin] = useState("");
  const [loading, setLoading] = useState(true);

  // نموذج إضافة مفتاح
  const [newProvider, setNewProvider] = useState("kie");
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);

  // نسخ JSON للبطاقة ج
  const [copied, setCopied] = useState<string | null>(null);
  const originRef = useRef("");

  const loadKeys = useCallback(async () => {
    try { const r = await fetch("/api/keys", { cache: "no-store" }); const j = await r.json(); setKeys(j.keys || []); } catch { /* تجاهل */ }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = await r.json();
      setTasks(j.tasks || []);
      setStats(j.stats || { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch { /* تجاهل */ }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch { setHealth(null); }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    originRef.current = window.location.origin;
    void loadHealth(); void loadKeys(); void loadTasks();
    setLoading(false);
    const h = setInterval(loadHealth, 15000);
    const t = setInterval(loadTasks, 5000);
    const k = setInterval(loadKeys, 20000);
    return () => { clearInterval(h); clearInterval(t); clearInterval(k); };
  }, [loadHealth, loadKeys, loadTasks]);

  // إضافة مفتاح مع رفض التكرار من السيرفر
  const addKey = async () => {
    if (!newKey.trim()) { toast({ title: "أدخل مفتاح API أولًا", variant: "destructive" }); return; }
    setAdding(true);
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: newProvider, api_key: newKey.trim(), label: newLabel.trim() }),
      });
      const j = await r.json();
      if (!r.ok) { toast({ title: j.error || "فشل إضافة المفتاح", variant: "destructive" }); return; }
      toast({ title: "تمت إضافة المفتاح — سيُجرَّب أولًا في الترتيب التسلسلي" });
      setNewKey(""); setNewLabel("");
      void loadKeys();
    } finally { setAdding(false); }
  };

  const toggleKey = async (k: SafeKey) => {
    const status = k.status === "disabled" ? "active" : "disabled";
    const r = await fetch(`/api/keys/${k.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    if (r.ok) { toast({ title: status === "disabled" ? "تم تعطيل المفتاح" : "تم تنشيط المفتاح" }); void loadKeys(); }
  };

  const deleteKey = async (k: SafeKey) => {
    const r = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (r.ok) { toast({ title: "تم حذف المفتاح" }); void loadKeys(); }
  };

  const copyText = async (text: string, tag: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(tag); setTimeout(() => setCopied(null), 1500); } catch { /* تجاهل */ }
  };

  // JSON جاهز للنسخ حسب العميل — مع ترويسة التوثيق عند ضبط MCP_ACCESS_TOKEN
  const mcpUrl = origin ? `${origin}/mcp` : "/mcp";
  const authHeader = health?.authRequired ? `"headers": {"Authorization": "Bearer <MCP_ACCESS_TOKEN>"}` : null;
  const jsonConfigs = useMemo(() => {
    const auth = authHeader ? `,\n        ${authHeader}` : "";
    return {
      chatgpt: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
      claude: `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
      cursor: `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${auth}\n    }\n  }\n}`,
    };
  }, [mcpUrl, authHeader]);

  const toolChips = [
    { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image مع تبديل تلقائي بين كل المفاتيح النشطة" },
    { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي عبر grok-imagine-video-1-5-preview مع image-to-video اختياري" },
    { name: "merge_videos", desc: "دمج 2–10 مقاطع في فيديو واحد بالترتيب المطلوب — روابط مباشرة أو معرفات مهام مكتملة" },
    { name: "get_task", desc: "تتبع أي مهمة بمعرّفها كل ~10 ثوانٍ حتى الاكتمال ثم عرض الروابط والانتهاء" },
    { name: "list_media", desc: "استرجاع أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها دون إعادة توليد" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0b0e17] via-[#0d1220] to-[#0b0e17] text-slate-100">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        {/* الهيدر + حالة الجهوزية */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl grad-bg grid place-items-center shadow-lg shadow-cyan-500/20">
              <ServerCog className="w-6 h-6 text-slate-950" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold grad-text">MCP Media Generator</h1>
              <p className="text-sm text-slate-400">خادم توليد الصور والفيديو ودمج المقاطع — لوحة إدارة عربية</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {health ? (
              <>
                <Badge className={health.database === "turso-connected" ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" : health.database === "local-dev" ? "bg-amber-500/15 text-amber-400 border border-amber-500/30" : "bg-red-500/15 text-red-400 border border-red-500/30"}>
                  {health.database === "turso-connected" ? "Turso متصل" : health.database === "local-dev" ? "قاعدة محلية (وضع التطوير)" : "غير متصل"}
                </Badge>
                <Badge className={health.merger?.healthy ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" : "bg-amber-500/15 text-amber-400 border border-amber-500/30"}>
                  خدمة الدمج {health.merger?.healthy ? "متاحة" : "غير متاحة"}
                </Badge>
                {health.authRequired && <Badge className="bg-purple-500/15 text-purple-300 border border-purple-500/30">/mcp محمي بـ Bearer token</Badge>}
              </>
            ) : (
              <Badge className="bg-slate-500/15 text-slate-400 border border-slate-500/30">جارٍ فحص الجهوزية…</Badge>
            )}
          </div>
        </header>

        {/* (أ) مدير المفاتيح */}
        <Card className="bg-[#111527]/90 border-[#2a3354]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <KeyRound className="w-5 h-5 text-cyan-400" /> مدير المفاتيح
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-[160px_1fr_1fr_auto] gap-3 items-end">
              <div className="space-y-1.5">
                <Label className="text-slate-300">المزود</Label>
                <Select value={newProvider} onValueChange={setNewProvider}>
                  <SelectTrigger className="bg-[#0d1220] border-[#2a3354]"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#161b2e] border-[#2a3354]">
                    <SelectItem value="kie">kie.ai</SelectItem>
                    <SelectItem value="cometapi">CometAPI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-300">تسمية (اختياري)</Label>
                <Input dir="auto" placeholder="مثال: حساب رئيسي" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} className="bg-[#0d1220] border-[#2a3354]" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-300">المفتاح</Label>
                <Input dir="ltr" type="password" placeholder="sk-..." value={newKey} onChange={(e) => setNewKey(e.target.value)} className="bg-[#0d1220] border-[#2a3354]" />
              </div>
              <Button onClick={addKey} disabled={adding} className="grad-bg text-slate-950 font-bold hover:opacity-90">
                <Plus className="w-4 h-4" /> إضافة
              </Button>
            </div>

            <p className="text-sm text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
            </p>

            <div className="max-h-96 overflow-y-auto rounded-xl space-y-2">
              {loading ? (
                <p className="text-slate-500 text-sm py-6 text-center">جارٍ التحميل…</p>
              ) : keys.length === 0 ? (
                <p className="text-slate-500 text-sm py-6 text-center">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.</p>
              ) : keys.map((k) => (
                <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-[#2a3354] bg-[#0d1220] px-3 py-2.5">
                  <Badge variant="outline" className="border-[#2a3354] text-slate-300">{k.provider === "kie" ? "kie.ai" : "CometAPI"}</Badge>
                  <code dir="ltr" className="text-xs text-cyan-300 font-mono flex-1 min-w-40 truncate">{k.masked}</code>
                  {k.label && <span className="text-xs text-slate-400">{k.label}</span>}
                  <StatusBadge status={k.status} />
                  <span className="text-xs text-slate-400">استخدام {k.usageCount} · نجاح {k.successCount} · فشل {k.failCount}</span>
                  {k.lastError && <span className="text-xs text-red-400 basis-full truncate" title={k.lastError}>آخر خطأ: {k.lastError}</span>}
                  <div className="flex gap-2 ms-auto">
                    <Button size="sm" variant="outline" className="h-8 border-[#2a3354]" onClick={() => toggleKey(k)}>
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-8 text-red-400 border-red-500/30 hover:bg-red-500/10" onClick={() => deleteKey(k)}>
                      <Trash2 className="w-3.5 h-3.5" /> حذف
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* (ب) لوحة المهام */}
        <Card className="bg-[#111527]/90 border-[#2a3354]">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Activity className="w-5 h-5 text-purple-400" /> لوحة المهام
            </CardTitle>
            <Button size="sm" variant="outline" className="border-[#2a3354]" onClick={() => { void loadTasks(); void loadHealth(); void loadKeys(); }}>
              <RefreshCw className="w-4 h-4" /> تحديث الآن
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* شرائح الإحصائيات */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatChip label="الإجمالي" value={stats.total} tone="slate" icon={<Activity className="w-4 h-4" />} />
              <StatChip label="مكتملة" value={stats.completed} tone="emerald" icon={<CheckCircle2 className="w-4 h-4" />} />
              <StatChip label="فاشلة" value={stats.failed} tone="red" icon={<XCircle className="w-4 h-4" />} />
              <StatChip label="جارية" value={stats.processing} tone="amber" icon={<Timer className="w-4 h-4" />} />
            </div>

            <div className="max-h-96 overflow-y-auto rounded-xl space-y-2">
              {tasks.length === 0 ? (
                <p className="text-slate-500 text-sm py-6 text-center">لا توجد مهام بعد — اتصل بأي عميل MCP واستدعِ generate_image أو generate_video.</p>
              ) : tasks.map((t) => (
                <div key={t.id} className="rounded-lg border border-[#2a3354] bg-[#0d1220] px-3 py-2.5 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-[#2a3354] text-slate-300">{STATUS_LABEL[t.type] || t.type}</Badge>
                    <StatusBadge status={t.status} />
                    <code dir="ltr" className="text-[11px] text-slate-500 font-mono truncate max-w-52">{t.id}</code>
                    <span className="text-xs text-slate-400">موديل: <code dir="ltr" className="font-mono text-cyan-300">{t.model}</code></span>
                    <span className="text-xs text-slate-500 ms-auto">{fmtTime(t.createdAt)}</span>
                  </div>
                  {t.prompt && <p className="text-xs text-slate-400 truncate">{t.prompt.slice(0, 120)}{t.prompt.length > 120 ? "…" : ""}</p>}
                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="flex items-center gap-3">
                      <Progress value={t.progress} className="h-2 flex-1 bg-[#1b2140] [&>div]:grad-bg" />
                      <span className="text-xs text-slate-400 w-12 text-center">{t.progress}%</span>
                    </div>
                  )}
                  {t.status === "completed" && t.resultUrls?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {t.resultUrls.map((u, i) => (
                        <a key={i} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 underline underline-offset-4">
                          <ExternalLink className="w-3.5 h-3.5" /> فتح الرابط {t.resultUrls!.length > 1 ? `#${i + 1}` : ""}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  {t.status === "failed" && t.errorMessage && <p className="text-xs text-red-400">❌ {t.errorMessage}</p>}
                  <div className="flex items-center gap-3 text-[11px] text-slate-500">
                    <span>المزود: {t.provider || "—"}</span>
                    <span>المحاولات: {t.attempts?.length || 0}</span>
                    {t.completedAt && <span>اكتملت: {fmtTime(t.completedAt)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* (ج) ربط السيرفر */}
        <Card className="bg-[#111527]/90 border-[#2a3354]">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Link2 className="w-5 h-5 text-cyan-400" /> ربط السيرفر
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Input dir="ltr" readOnly value={mcpUrl} className="bg-[#0d1220] border-[#2a3354] font-mono text-sm flex-1 min-w-60" />
              <Button size="sm" variant="outline" className="border-[#2a3354]" onClick={() => copyText(mcpUrl, "url")}>
                {copied === "url" ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />} نسخ
              </Button>
            </div>

            <Tabs defaultValue="chatgpt" dir="rtl">
              <TabsList className="bg-[#0d1220] border border-[#2a3354] h-auto flex-wrap w-full gap-1 p-1">
                <TabsTrigger value="chatgpt" className="text-xs sm:text-sm">ChatGPT / GPT Agents</TabsTrigger>
                <TabsTrigger value="claude" className="text-xs sm:text-sm">Claude Desktop</TabsTrigger>
                <TabsTrigger value="cursor" className="text-xs sm:text-sm">Cursor / Windsurf / Cline</TabsTrigger>
              </TabsList>
              <TabsContent value="chatgpt" className="space-y-2">
                <p className="text-xs text-slate-400">في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».</p>
                <CodeBlock json={jsonConfigs.chatgpt} onCopy={() => copyText(jsonConfigs.chatgpt, "chatgpt")} copied={copied === "chatgpt"} />
              </TabsContent>
              <TabsContent value="claude" className="space-y-2">
                <p className="text-xs text-slate-400">أضفه في ملف <code dir="ltr">claude_desktop_config.json</code> ثم أعد تشغيل التطبيق.</p>
                <CodeBlock json={jsonConfigs.claude} onCopy={() => copyText(jsonConfigs.claude, "claude")} copied={copied === "claude"} />
              </TabsContent>
              <TabsContent value="cursor" className="space-y-2">
                <p className="text-xs text-slate-400">أضفه في ملف <code dir="ltr">mcp.json</code> (Cursor: Settings → MCP) أو إعدادات Windsurf/Cline.</p>
                <CodeBlock json={jsonConfigs.cursor} onCopy={() => copyText(jsonConfigs.cursor, "cursor")} copied={copied === "cursor"} />
              </TabsContent>
            </Tabs>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {toolChips.map((t) => (
                <div key={t.name} className="rounded-lg border border-[#2a3354] bg-[#0d1220] px-3 py-2">
                  <code dir="ltr" className="text-xs font-bold text-cyan-300 font-mono">{t.name}</code>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">{t.desc}</p>
                </div>
              ))}
            </div>

            <p className="text-sm text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 leading-relaxed">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
            </p>
          </CardContent>
        </Card>

        <footer className="text-center text-xs text-slate-500 pb-6">
          روابط فقط — لا تُنزَّل الوسائط على السيرفر · المفاتيح مُقنَّعة دائمًا · التبديل التسلسلي الصارم دون توقف
        </footer>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    exhausted: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    disabled: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    completed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    failed: "bg-red-500/15 text-red-400 border-red-500/30",
    processing: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pending: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  };
  return <Badge className={map[status] || "bg-slate-500/15 text-slate-400 border-slate-500/30"}>{STATUS_LABEL[status] || status}</Badge>;
}

function StatChip({ label, value, tone, icon }: { label: string; value: number; tone: string; icon: React.ReactNode }) {
  const tones: Record<string, string> = {
    slate: "text-slate-300", emerald: "text-emerald-400", red: "text-red-400", amber: "text-amber-400",
  };
  return (
    <div className="rounded-lg border border-[#2a3354] bg-[#0d1220] px-4 py-3">
      <div className={`flex items-center gap-2 text-sm ${tones[tone]}`}>{icon}{label}</div>
      <div className="text-2xl font-extrabold mt-1">{value}</div>
    </div>
  );
}

function CodeBlock({ json, onCopy, copied }: { json: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="relative">
      <pre dir="ltr" className="text-left text-xs bg-[#0a0d18] border border-[#2a3354] rounded-lg p-4 overflow-x-auto text-cyan-200 font-mono leading-relaxed">{json}</pre>
      <Button size="sm" variant="outline" className="absolute top-2 left-2 h-7 border-[#2a3354] bg-[#0d1220]" onClick={onCopy}>
        {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />} نسخ
      </Button>
    </div>
  );
}
