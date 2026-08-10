import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { TeamPost } from "@/types/team";

export const runtime = "nodejs";

const inputSchema = z.object({
  postType: z.enum(["recruit", "join"]),
  title: z.string().trim().min(4).max(80),
  artistName: z.string().trim().min(1).max(50),
  primaryField: z.string().trim().min(1).max(30),
  region: z.string().trim().min(1).max(30),
  wantedRole: z.string().trim().min(1).max(50),
  headcount: z.number().int().min(1).max(30),
  activityType: z.string().trim().min(1).max(30),
  projectDate: z.string().trim().max(30),
  compensation: z.enum(["paid", "negotiable", "exchange", "volunteer"]),
  description: z.string().trim().min(10).max(1200),
  highlights: z.array(z.string().trim().min(1).max(140)).max(4),
  profileImage: z.string().max(260_000),
  profileUrl: z.string().trim().max(300),
  contact: z.string().trim().min(3).max(200),
  website: z.string().max(0).optional(),
});

const patchSchema = z.object({ id: z.string().uuid(), editToken: z.string().min(20).max(200), status: z.enum(["open", "closed"]) });
const rateLimit = new Map<string, number[]>();

function config() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function supabaseHeaders(key: string, extra: Record<string, string> = {}) {
  return {
    apikey: key,
    ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
    "Content-Type": "application/json",
    ...extra,
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function fromRow(row: Record<string, unknown>): TeamPost {
  return {
    id: String(row.id), postType: row.post_type as TeamPost["postType"], status: row.status as TeamPost["status"],
    title: String(row.title), artistName: String(row.artist_name), primaryField: String(row.primary_field), region: String(row.region),
    wantedRole: String(row.wanted_role), headcount: Number(row.headcount), activityType: String(row.activity_type), projectDate: String(row.project_date || ""),
    compensation: row.compensation as TeamPost["compensation"], description: String(row.description), highlights: Array.isArray(row.highlights) ? row.highlights.map(String) : [],
    profileImage: String(row.profile_image || ""), profileUrl: String(row.profile_url || ""), contact: String(row.contact), createdAt: String(row.created_at),
  };
}

export async function GET() {
  const database = config();
  if (!database) return NextResponse.json({ posts: [], storage: "local" });
  try {
    const response = await fetch(`${database.url}/rest/v1/team_posts?select=*&order=created_at.desc&limit=100`, { headers: supabaseHeaders(database.key), cache: "no-store" });
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    const rows = await response.json() as Array<Record<string, unknown>>;
    return NextResponse.json({ posts: rows.map(fromRow), storage: "shared" });
  } catch (error) {
    console.error("Team posts read failed", error);
    return NextResponse.json({ posts: [], storage: "local", warning: "공용 게시판 연결이 어려워 현재 기기 저장으로 전환했습니다." });
  }
}

export async function POST(request: Request) {
  const database = config();
  if (!database) return NextResponse.json({ error: "공용 저장소가 설정되지 않았습니다.", code: "LOCAL_STORAGE_REQUIRED" }, { status: 503 });
  try {
    const input = inputSchema.parse(await request.json());
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const now = Date.now();
    const recent = (rateLimit.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= 3) return NextResponse.json({ error: "한 시간에 최대 3개의 모집글을 작성할 수 있습니다." }, { status: 429 });
    const editToken = `${randomUUID()}-${randomBytes(16).toString("hex")}`;
    const row = {
      id: randomUUID(), post_type: input.postType, status: "open", title: input.title, artist_name: input.artistName,
      primary_field: input.primaryField, region: input.region, wanted_role: input.wantedRole, headcount: input.headcount,
      activity_type: input.activityType, project_date: input.projectDate, compensation: input.compensation,
      description: input.description, highlights: input.highlights, profile_image: input.profileImage,
      profile_url: input.profileUrl, contact: input.contact, edit_token_hash: hash(editToken),
    };
    const response = await fetch(`${database.url}/rest/v1/team_posts`, { method: "POST", headers: supabaseHeaders(database.key, { Prefer: "return=representation" }), body: JSON.stringify(row) });
    if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
    rateLimit.set(ip, [...recent, now]);
    const [created] = await response.json() as Array<Record<string, unknown>>;
    return NextResponse.json({ post: fromRow(created), editToken }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "필수 모집 정보를 확인해 주세요.", details: error.issues }, { status: 400 });
    console.error("Team post create failed", error);
    return NextResponse.json({ error: "모집글을 저장하지 못했습니다." }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  const database = config();
  if (!database) return NextResponse.json({ error: "공용 저장소가 설정되지 않았습니다." }, { status: 503 });
  try {
    const input = patchSchema.parse(await request.json());
    const lookup = await fetch(`${database.url}/rest/v1/team_posts?id=eq.${input.id}&select=edit_token_hash`, { headers: supabaseHeaders(database.key), cache: "no-store" });
    const [row] = await lookup.json() as Array<{ edit_token_hash?: string }>;
    if (!row || row.edit_token_hash !== hash(input.editToken)) return NextResponse.json({ error: "수정 권한을 확인할 수 없습니다." }, { status: 403 });
    const response = await fetch(`${database.url}/rest/v1/team_posts?id=eq.${input.id}`, { method: "PATCH", headers: supabaseHeaders(database.key, { Prefer: "return=representation" }), body: JSON.stringify({ status: input.status }) });
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    const [updated] = await response.json() as Array<Record<string, unknown>>;
    return NextResponse.json({ post: fromRow(updated) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "수정 요청이 올바르지 않습니다." }, { status: 400 });
    console.error("Team post update failed", error);
    return NextResponse.json({ error: "모집 상태를 변경하지 못했습니다." }, { status: 502 });
  }
}
