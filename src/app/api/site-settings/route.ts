import { NextResponse } from "next/server";
import { z } from "zod";
import { defaultSiteConfig, mergeSiteConfig } from "@/types/site-config";

export const runtime = "nodejs";

const configSchema = z.object({
  version: z.number().int(),
  brand: z.object({ name: z.string().min(1).max(40), mark: z.string().min(1).max(3), tagline: z.string().max(100) }),
  navigation: z.object({ studio: z.string().min(1).max(30), team: z.string().min(1).max(30), admin: z.string().min(1).max(30), newProject: z.string().min(1).max(30) }),
  theme: z.object({ primary: z.string().regex(/^#[0-9a-f]{6}$/i), accent: z.string().regex(/^#[0-9a-f]{6}$/i), ink: z.string().regex(/^#[0-9a-f]{6}$/i), paper: z.string().regex(/^#[0-9a-f]{6}$/i), surface: z.string().regex(/^#[0-9a-f]{6}$/i), radius: z.number().min(0).max(36), contentWidth: z.number().min(900).max(1500), fontScale: z.number().min(85).max(120), headerStyle: z.enum(["solid", "glass"]) }),
  home: z.object({ eyebrow: z.string().max(50), title: z.string().min(1).max(60), accentTitle: z.string().min(1).max(60), description: z.string().max(240), uploadTitle: z.string().max(80), uploadDescription: z.string().max(160), noMaterialLabel: z.string().max(80), trustItems: z.array(z.string().max(50)).min(1).max(5), sections: z.array(z.object({ key: z.enum(["identity", "upload", "link", "aiStatus", "trust"]), enabled: z.boolean() })).length(5) }),
  team: z.object({ eyebrow: z.string().max(60), title: z.string().min(1).max(120), description: z.string().max(240), createLabel: z.string().max(30), searchPlaceholder: z.string().max(60), showDemoPosts: z.boolean() }),
  updatedAt: z.string(),
});

function databaseConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}
function headers(key: string, extra: Record<string, string> = {}) { return { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json", ...extra }; }

export async function GET() {
  const database = databaseConfig();
  if (!database) return NextResponse.json({ config: defaultSiteConfig, storage: "local" });
  try {
    const response = await fetch(`${database.url}/rest/v1/site_settings?id=eq.main&select=config,updated_at`, { headers: headers(database.key), cache: "no-store" });
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    const [row] = await response.json() as Array<{ config?: unknown; updated_at?: string }>;
    return NextResponse.json({ config: row?.config ? mergeSiteConfig(row.config as Partial<typeof defaultSiteConfig>) : defaultSiteConfig, storage: "shared", updatedAt: row?.updated_at || "" });
  } catch (error) {
    console.error("Site settings read failed", error);
    return NextResponse.json({ config: defaultSiteConfig, storage: "local", warning: "공용 설정을 읽지 못해 기본 설정을 사용합니다." });
  }
}

export async function PUT(request: Request) {
  const database = databaseConfig();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!database || !adminPassword) return NextResponse.json({ error: "공용 게시 설정이 아직 연결되지 않았습니다.", code: "LOCAL_PREVIEW_ONLY" }, { status: 503 });
  const authorization = request.headers.get("authorization") || "";
  if (authorization !== `Bearer ${adminPassword}`) return NextResponse.json({ error: "관리자 비밀번호가 올바르지 않습니다." }, { status: 401 });
  try {
    const config = configSchema.parse(await request.json());
    const published = { ...config, version: config.version + 1, updatedAt: new Date().toISOString() };
    const response = await fetch(`${database.url}/rest/v1/site_settings?on_conflict=id`, { method: "POST", headers: headers(database.key, { Prefer: "resolution=merge-duplicates,return=representation" }), body: JSON.stringify({ id: "main", config: published, updated_at: published.updatedAt }) });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    return NextResponse.json({ config: published, storage: "shared" });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "입력한 디자인 설정을 확인해 주세요.", details: error.issues }, { status: 400 });
    console.error("Site settings publish failed", error);
    return NextResponse.json({ error: "사이트 설정을 게시하지 못했습니다." }, { status: 502 });
  }
}
