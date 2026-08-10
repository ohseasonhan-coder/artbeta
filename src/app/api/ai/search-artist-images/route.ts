import { GoogleGenAI, type Part } from "@google/genai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

type Source = "naver" | "google" | "youtube";

interface Candidate {
  id: string;
  source: Source;
  imageUrl: string;
  sourceUrl: string;
  title: string;
  width: number;
  height: number;
  dataUrl?: string;
}

const matchSchema = z.object({
  matches: z.array(z.object({
    id: z.string(),
    relevanceScore: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
    recommended: z.boolean(),
    watermarkDetected: z.boolean().default(false),
    rightsRisk: z.enum(["low", "unknown", "high"]).default("unknown"),
    reason: z.string(),
  })),
});

function buildQueries(artistName: string, primaryField: string, region: string, careers: Array<{ title?: string; organization?: string }>) {
  const base = [`"${artistName}"`, primaryField, region, "공식 공연 아티스트"].filter(Boolean).join(" ");
  const careerQueries = careers
    .filter((career) => career.title?.trim() || career.organization?.trim())
    .slice(0, 2)
    .map((career) => [`"${artistName}"`, career.title, career.organization, primaryField].filter(Boolean).join(" "));
  return [...new Set([base, ...careerQueries])].slice(0, 3);
}

async function searchNaver(query: string, queryIndex: number): Promise<Candidate[]> {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return [];
  const url = new URL("https://openapi.naver.com/v1/search/image");
  url.searchParams.set("query", query);
  url.searchParams.set("display", "8");
  url.searchParams.set("sort", "sim");
  url.searchParams.set("filter", "large");
  const response = await fetch(url, { headers: { "X-Naver-Client-Id": process.env.NAVER_CLIENT_ID, "X-Naver-Client-Secret": process.env.NAVER_CLIENT_SECRET } });
  if (!response.ok) throw new Error(`Naver image search ${response.status}`);
  const data = await response.json() as { items?: Array<{ title?: string; link?: string; thumbnail?: string; sizewidth?: string; sizeheight?: string }> };
  return (data.items ?? []).map((item, index) => ({
    id: `naver-${queryIndex}-${index}`,
    source: "naver" as const,
    imageUrl: item.link || item.thumbnail || "",
    sourceUrl: item.link || item.thumbnail || "",
    title: (item.title || "네이버 이미지").replace(/<[^>]+>/g, ""),
    width: Number(item.sizewidth) || 0,
    height: Number(item.sizeheight) || 0,
  })).filter((item) => item.imageUrl);
}

async function searchGoogle(query: string, queryIndex: number): Promise<Candidate[]> {
  if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_ENGINE_ID) return [];
  const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
  url.searchParams.set("key", process.env.GOOGLE_SEARCH_API_KEY);
  url.searchParams.set("cx", process.env.GOOGLE_SEARCH_ENGINE_ID);
  url.searchParams.set("q", query);
  url.searchParams.set("searchType", "image");
  url.searchParams.set("safe", "active");
  url.searchParams.set("imgSize", "large");
  url.searchParams.set("num", "8");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google image search ${response.status}`);
  const data = await response.json() as { items?: Array<{ title?: string; link?: string; image?: { contextLink?: string; width?: number; height?: number; thumbnailLink?: string } }> };
  return (data.items ?? []).map((item, index) => ({
    id: `google-${queryIndex}-${index}`,
    source: "google" as const,
    imageUrl: item.link || item.image?.thumbnailLink || "",
    sourceUrl: item.image?.contextLink || item.link || "",
    title: item.title || "Google 이미지",
    width: item.image?.width || 0,
    height: item.image?.height || 0,
  })).filter((item) => item.imageUrl);
}

async function searchYoutube(query: string, queryIndex: number): Promise<Candidate[]> {
  if (!process.env.YOUTUBE_API_KEY) return [];
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", process.env.YOUTUBE_API_KEY);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "8");
  url.searchParams.set("regionCode", "KR");
  url.searchParams.set("relevanceLanguage", "ko");
  url.searchParams.set("safeSearch", "strict");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`YouTube search ${response.status}`);
  const data = await response.json() as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; thumbnails?: Record<string, { url?: string; width?: number; height?: number }> } }> };
  return (data.items ?? []).map((item, index) => {
    const thumb = item.snippet?.thumbnails?.maxres || item.snippet?.thumbnails?.high || item.snippet?.thumbnails?.medium;
    return {
      id: `youtube-${queryIndex}-${index}`,
      source: "youtube" as const,
      imageUrl: thumb?.url || "",
      sourceUrl: item.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : "https://www.youtube.com",
      title: [item.snippet?.title, item.snippet?.channelTitle].filter(Boolean).join(" · "),
      width: thumb?.width || 0,
      height: thumb?.height || 0,
    };
  }).filter((item) => item.imageUrl);
}

async function downloadImage(candidate: Candidate): Promise<Candidate | null> {
  try {
    const url = new URL(candidate.imageUrl);
    if (url.protocol !== "https:") return null;
    const addresses = await lookup(url.hostname, { all: true });
    const unsafe = addresses.some(({ address }) => {
      if (isIP(address) === 6) return address === "::1" || address.toLowerCase().startsWith("fc") || address.toLowerCase().startsWith("fd") || address.toLowerCase().startsWith("fe80:");
      const [a, b] = address.split(".").map(Number);
      return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    });
    if (unsafe) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "error", headers: { "User-Agent": "ArtfolioStudio/1.0" } });
    if (!response.ok) return null;
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "";
    if (!mimeType.startsWith("image/")) return null;
    const declaredSize = Number(response.headers.get("content-length")) || 0;
    if (declaredSize > 6 * 1024 * 1024) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 6 * 1024 * 1024) return null;
    const image = await loadImage(buffer);
    const scale = Math.min(1, 960 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    const optimized = canvas.toBuffer("image/jpeg", 82);
    return { ...candidate, width: candidate.width || image.width, height: candidate.height || image.height, dataUrl: `data:image/jpeg;base64,${optimized.toString("base64")}` };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { artistName?: string; primaryField?: string; region?: string; referenceImage?: string; careers?: Array<{ title?: string; organization?: string }> };
    const artistName = body.artistName?.trim() || "";
    if (!artistName || !body.referenceImage?.startsWith("data:image/")) {
      return NextResponse.json({ error: "아티스트명과 대표사진이 필요합니다." }, { status: 400 });
    }
    const configuredSources = [
      process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET ? "naver" : "",
      process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID ? "google" : "",
      process.env.YOUTUBE_API_KEY ? "youtube" : "",
    ].filter(Boolean);
    if (!configuredSources.length) {
      return NextResponse.json({ error: "웹 이미지 검색 API가 설정되지 않았습니다.", code: "SEARCH_NOT_CONFIGURED" }, { status: 503 });
    }

    const queries = buildQueries(artistName, body.primaryField || "", body.region || "", body.careers ?? []);
    const searched = await Promise.allSettled(queries.flatMap((query, queryIndex) => [searchNaver(query, queryIndex), searchGoogle(query, queryIndex), searchYoutube(query, queryIndex)]));
    const unique = new Map<string, Candidate>();
    searched.forEach((result) => {
      if (result.status === "fulfilled") result.value.forEach((candidate) => { if (!unique.has(candidate.imageUrl)) unique.set(candidate.imageUrl, candidate); });
    });
    const downloaded = (await Promise.all([...unique.values()].slice(0, 18).map(downloadImage))).filter((candidate): candidate is Candidate & { dataUrl: string } => Boolean(candidate?.dataUrl)).slice(0, 10);
    if (!downloaded.length) return NextResponse.json({ error: "검색 결과 이미지를 불러오지 못했습니다." }, { status: 502 });

    let scores = new Map<string, { relevanceScore: number; qualityScore: number; recommended: boolean; watermarkDetected: boolean; rightsRisk: "low" | "unknown" | "high"; reason: string }>();
    if (process.env.GEMINI_API_KEY) {
      try {
      const reference = body.referenceImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      const parts: Part[] = [{ text: `문화예술인 웹 이미지 후보를 검수합니다. 검색 대상은 '${artistName}'이며 분야는 '${body.primaryField || "미지정"}'입니다. 첫 이미지는 사용자가 직접 등록한 참고 사진이고, 이후 이미지는 검색 후보입니다. 얼굴 생체인증이나 동일인 확정을 하지 마세요. 검색 제목·출처의 이름 일치, 개인/단체 구성, 활동 분야와 무대 맥락, 해상도와 구도를 평가하세요. 이미지의 모서리·중앙·반복 패턴에 워터마크, 스톡 사이트 마크, 언론사 로고, 저작권자 서명 또는 큰 텍스트 오버레이가 있으면 watermarkDetected=true와 rightsRisk=high로 지정하고 recommended=false로 두세요. 사용 허가가 불명확하면 rightsRisk=unknown으로 지정하세요. 추천은 관련성이 높고 워터마크가 없으며 출처 페이지에서 사용 권한을 확인할 수 있는 후보에만 허용하세요. 타인 가능성이 있으면 recommended=false로 두고 사용자가 최종 확인해야 한다고 reason에 적으세요.` }];
      if (reference) parts.push({ text: "사용자 등록 참고 사진" }, { inlineData: { mimeType: reference[1], data: reference[2] } });
      downloaded.forEach((candidate) => {
        const match = candidate.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        parts.push({ text: `후보 ID=${candidate.id}, 출처=${candidate.source}, 제목=${candidate.title}, 원본크기=${candidate.width}x${candidate.height}` });
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
      });
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
        contents: [{ role: "user", parts }],
        config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(matchSchema), temperature: 0.1 },
      });
      const parsed = matchSchema.parse(JSON.parse(response.text || "{}"));
      scores = new Map(parsed.matches.map((match) => [match.id, match]));
      } catch (error) {
        console.warn("Web image safety review failed; returning unapproved candidates", error);
      }
    }

    const candidates = downloaded.map((candidate) => {
      const fallbackQuality = candidate.width >= 800 || candidate.height >= 800 ? 0.78 : 0.58;
      const fallbackRelevance = candidate.title.toLowerCase().includes(artistName.toLowerCase()) ? 0.76 : 0.55;
      const score = scores.get(candidate.id) || { relevanceScore: fallbackRelevance, qualityScore: fallbackQuality, recommended: false, watermarkDetected: false, rightsRisk: "unknown" as const, reason: "검색 문맥만 확인됨 · 출처와 사용 권한을 직접 확인해야 합니다." };
      const usageStatus = score.watermarkDetected || score.rightsRisk === "high" ? "blocked" : score.recommended && score.rightsRisk === "low" ? "approved" : "review";
      return { ...candidate, relevanceScore: score.relevanceScore, qualityScore: score.qualityScore, watermarkDetected: score.watermarkDetected, rightsRisk: score.rightsRisk, usageStatus, recommended: usageStatus === "approved" && score.relevanceScore >= 0.72 && score.qualityScore >= 0.65, reason: score.reason };
    }).sort((a, b) => Number(b.recommended) - Number(a.recommended) || (b.relevanceScore + b.qualityScore) - (a.relevanceScore + a.qualityScore));

    return NextResponse.json({ query: queries.join(" | "), configuredSources, candidates });
  } catch (error) {
    console.error("Artist image search failed", error);
    return NextResponse.json({ error: "아티스트 이미지 검색을 완료하지 못했습니다." }, { status: 502 });
  }
}
