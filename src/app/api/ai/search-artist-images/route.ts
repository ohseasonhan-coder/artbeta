import { GoogleGenAI, type Part } from "@google/genai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

type Source = "naver" | "google" | "youtube" | "wikimedia";

interface Candidate {
  id: string;
  source: Source;
  imageUrl: string;
  sourceUrl: string;
  title: string;
  width: number;
  height: number;
  dataUrl?: string;
  license?: string;
}

const matchSchema = z.object({
  matches: z.array(z.object({
    id: z.string(),
    relevanceScore: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
    recommended: z.boolean(),
    identityScore: z.number().min(0).max(1).default(0),
    visualMatchScore: z.number().min(0).max(1).default(0),
    referenceSignals: z.array(z.string()).max(8).default([]),
    visualRole: z.enum(["portrait", "stage", "poster", "history", "other", "exclude"]).default("other"),
    identityConflicts: z.array(z.string()).max(8).default([]),
    duplicateOf: z.string().nullable().default(null),
    watermarkDetected: z.boolean().default(false),
    rightsRisk: z.enum(["low", "unknown", "high"]).default("unknown"),
    reason: z.string(),
  })),
});

function buildQueries(artistName: string, primaryField: string, region: string, affiliation: string, identityHint: string, activeSince: string, officialUrl: string, careers: Array<{ title?: string; organization?: string }>) {
  const base = [`"${artistName}"`, affiliation || identityHint || primaryField, region, activeSince, officialUrl, "공식 공연 아티스트"].filter(Boolean).join(" ");
  const careerQueries = careers
    .filter((career) => career.title?.trim() || career.organization?.trim())
    .slice(0, 2)
    .map((career) => [`"${artistName}"`, affiliation, career.title, career.organization, primaryField].filter(Boolean).join(" "));
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

async function searchWikimedia(query: string, queryIndex: number, field: string): Promise<Candidate[]> {
  const artistName = query.match(/"([^"]+)"/)?.[1] || query.replace(/https?:\/\/\S+/g, "").trim().split(/\s+/).slice(0, 2).join(" ");
  const focusedQuery = [artistName, field, "artist performance"].filter(Boolean).join(" ");
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query"); url.searchParams.set("format", "json"); url.searchParams.set("origin", "*");
  url.searchParams.set("generator", "search"); url.searchParams.set("gsrsearch", focusedQuery); url.searchParams.set("gsrnamespace", "6"); url.searchParams.set("gsrlimit", "8");
  url.searchParams.set("prop", "imageinfo"); url.searchParams.set("iiprop", "url|size|mime|extmetadata"); url.searchParams.set("iiurlwidth", "1200");
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) return [];
  const data = await response.json() as { query?: { pages?: Record<string, { title?: string; imageinfo?: Array<{ url?: string; thumburl?: string; descriptionurl?: string; width?: number; height?: number; mime?: string; extmetadata?: { LicenseShortName?: { value?: string } } }> }> } };
  return Object.values(data.query?.pages ?? {}).map((page, index) => {
    const image = page.imageinfo?.[0];
    return { id: `wikimedia-${queryIndex}-${index}`, source: "wikimedia" as const, imageUrl: image?.thumburl || image?.url || "", sourceUrl: image?.descriptionurl || "https://commons.wikimedia.org", title: (page.title || "Wikimedia Commons").replace(/^File:/, ""), width: image?.width || 0, height: image?.height || 0, license: image?.extmetadata?.LicenseShortName?.value || "" };
  }).filter((item) => item.imageUrl && /\.(?:jpe?g|png|webp)(?:\?|$)/i.test(item.imageUrl));
}

async function searchWikipediaLead(query: string, queryIndex: number): Promise<Candidate[]> {
  const artistName = query.match(/"([^"]+)"/)?.[1] || query.trim().split(/\s+/).slice(0, 2).join(" ");
  const languages = ["ko", "en"];
  const results = await Promise.all(languages.map(async (language) => {
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    url.searchParams.set("action", "query"); url.searchParams.set("format", "json"); url.searchParams.set("origin", "*");
    url.searchParams.set("generator", "search"); url.searchParams.set("gsrsearch", artistName); url.searchParams.set("gsrlimit", "4");
    url.searchParams.set("prop", "pageimages|info"); url.searchParams.set("piprop", "thumbnail|original"); url.searchParams.set("pithumbsize", "1200"); url.searchParams.set("inprop", "url");
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) }); if (!response.ok) return [];
    const data = await response.json() as { query?: { pages?: Record<string, { title?: string; fullurl?: string; thumbnail?: { source?: string; width?: number; height?: number }; original?: { source?: string; width?: number; height?: number } }> } };
    return Object.values(data.query?.pages ?? {}).map((page, index) => ({ id: `wikipedia-${language}-${queryIndex}-${index}`, source: "wikimedia" as const, imageUrl: page.thumbnail?.source || page.original?.source || "", sourceUrl: page.fullurl || `https://${language}.wikipedia.org`, title: `${page.title || artistName} · Wikipedia ${language.toUpperCase()}`, width: page.original?.width || page.thumbnail?.width || 0, height: page.original?.height || page.thumbnail?.height || 0, license: "Wikipedia/Wikimedia 원문 라이선스 확인" })).filter((item) => item.imageUrl);
  }));
  return results.flat();
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
    const body = await request.json() as { artistName?: string; primaryField?: string; region?: string; affiliation?: string; activeSince?: string; identityHint?: string; officialUrl?: string; referenceImage?: string; careers?: Array<{ title?: string; organization?: string }> };
    const artistName = body.artistName?.trim() || "";
    if (!artistName || !body.referenceImage?.startsWith("data:image/")) {
      return NextResponse.json({ error: "아티스트명과 대표사진이 필요합니다." }, { status: 400 });
    }
    const configuredSources = [
      "wikimedia",
      process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET ? "naver" : "",
      process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID ? "google" : "",
      process.env.YOUTUBE_API_KEY ? "youtube" : "",
    ].filter(Boolean);
    const queries = buildQueries(artistName, body.primaryField || "", body.region || "", body.affiliation || "", body.identityHint || "", body.activeSince || "", body.officialUrl || "", body.careers ?? []);
    const searched = await Promise.allSettled(queries.flatMap((query, queryIndex) => [searchWikipediaLead(query, queryIndex), searchWikimedia(query, queryIndex, body.primaryField || ""), searchNaver(query, queryIndex), searchGoogle(query, queryIndex), searchYoutube(query, queryIndex)]));
    const unique = new Map<string, Candidate>();
    searched.forEach((result) => {
      if (result.status === "fulfilled") result.value.forEach((candidate) => { if (!unique.has(candidate.imageUrl)) unique.set(candidate.imageUrl, candidate); });
    });
    const downloaded = (await Promise.all([...unique.values()].slice(0, 18).map(downloadImage))).filter((candidate): candidate is Candidate & { dataUrl: string } => Boolean(candidate?.dataUrl)).slice(0, 10);
    if (!downloaded.length) return NextResponse.json({ error: "검색 결과 이미지를 불러오지 못했습니다." }, { status: 502 });

    let scores = new Map<string, { relevanceScore: number; qualityScore: number; recommended: boolean; identityScore: number; visualMatchScore: number; referenceSignals: string[]; visualRole: "portrait" | "stage" | "poster" | "history" | "other" | "exclude"; identityConflicts: string[]; duplicateOf: string | null; watermarkDetected: boolean; rightsRisk: "low" | "unknown" | "high"; reason: string }>();
    if (process.env.GEMINI_API_KEY) {
      try {
      const reference = body.referenceImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      const parts: Part[] = [{ text: `문화예술인 웹 이미지 후보를 엄격하게 검수합니다. 검색 대상은 '${artistName}'이며 분야는 '${body.primaryField || "미지정"}'입니다. 첫 이미지는 사용자가 직접 등록했거나 기존 PDF·PPTX에서 선택한 기준 이미지이고, 이후 이미지는 검색 후보입니다. 생체인증이나 신원 확정을 하지 말고, 보이는 시각적 일관성과 검색 문맥만 평가하세요. 기준 이미지와 후보의 개인/단체 구성, 대략적인 연령대, 헤어스타일·의상·얼굴의 비식별 외형 특징, 공연 장르, 악기·작품·무대 환경이 일치하는 근거를 referenceSignals에 적고 visualMatchScore로 평가하세요. 기준 또는 후보에 비교할 인물이 선명하지 않으면 visualMatchScore는 최대 0.74입니다. 이름만 일치하는 것은 동일 인물 근거가 아닙니다. visualRole은 portrait=인물 대표사진, stage=무대·활동사진, poster=포스터, history=연혁·수상·보도자료, other=보조 이미지, exclude=관련 없음으로 분류하세요. 후보끼리 같은 사진, 같은 영상 썸네일, 재크롭·축소본이면 가장 선명한 한 장만 남기고 나머지는 duplicateOf에 원본 후보 ID를 기록하며 recommended=false로 두세요. 중복이 아니면 duplicateOf=null입니다. 이미지의 모서리·중앙·반복 패턴에 워터마크, 스톡 사이트 마크, 언론사 로고, 저작권자 서명 또는 큰 텍스트 오버레이가 있으면 watermarkDetected=true와 rightsRisk=high로 지정하고 recommended=false로 두세요. 사용 허가가 불명확하면 rightsRisk=unknown으로 지정하세요. recommended=true는 identityScore와 visualMatchScore가 모두 0.82 이상이고 충돌이 없으며 관련성·품질·권리 조건도 통과한 후보에만 허용하세요. 타인 가능성이 조금이라도 있으면 recommended=false로 두세요.` }];
      parts.push({ text: `동명이인 판별 단서: 지역=${body.region || "미입력"}, 소속=${body.affiliation || "미입력"}, 활동 시작=${body.activeSince || "미입력"}, 대표 경력=${body.identityHint || "미입력"}, 공식 링크=${body.officialUrl || "미입력"}. 후보마다 이름 외 단서가 얼마나 일치하는지 identityScore로 평가하고 충돌은 identityConflicts에 적으세요. 소속·분야·지역·활동 시기 중 명확한 충돌이 있거나 identityScore가 0.7 미만이면 recommended=false로 두세요.` });
      if (reference) parts.push({ text: "사용자 등록 참고 사진" }, { inlineData: { mimeType: reference[1], data: reference[2] } });
      downloaded.forEach((candidate) => {
        const match = candidate.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
        parts.push({ text: `후보 ID=${candidate.id}, 출처=${candidate.source}, 제목=${candidate.title}, 원본크기=${candidate.width}x${candidate.height}${candidate.license ? `, 라이선스=${candidate.license}` : ""}` });
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

    const identityTerms = [artistName, body.affiliation, body.identityHint]
      .flatMap((value) => (value || "").toLowerCase().split(/[\s·|,/()[\]-]+/))
      .map((value) => value.replace(/[^0-9a-z가-힣]/g, ""))
      .filter((value) => value.length >= 2);
    const candidates = downloaded.map((candidate) => {
      const fallbackQuality = candidate.width >= 800 || candidate.height >= 800 ? 0.78 : 0.58;
      const searchableTitle = candidate.title.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
      const titleIdentityMatch = identityTerms.some((term) => searchableTitle.includes(term));
      const fallbackRelevance = titleIdentityMatch ? 0.76 : 0.35;
      const score = scores.get(candidate.id) || { relevanceScore: fallbackRelevance, qualityScore: fallbackQuality, recommended: false, identityScore: 0, visualMatchScore: 0, referenceSignals: [], visualRole: "other" as const, identityConflicts: [], duplicateOf: null, watermarkDetected: false, rightsRisk: candidate.source === "wikimedia" && candidate.license ? "low" as const : "unknown" as const, reason: candidate.license ? `Wikimedia Commons ${candidate.license} · 동일 인물 여부를 직접 확인해야 합니다.` : "검색 문맥만 확인됨 · 동일 인물과 사용 권한을 직접 확인해야 합니다." };
      const identityApproved = score.identityScore >= 0.82 && score.visualMatchScore >= 0.82 && score.referenceSignals.length > 0 && !score.identityConflicts.length && !score.duplicateOf && score.relevanceScore >= 0.78;
      const usageStatus = score.duplicateOf || score.watermarkDetected || score.rightsRisk === "high" || score.visualRole === "exclude" ? "blocked" : score.recommended && score.rightsRisk === "low" && identityApproved && score.qualityScore >= 0.65 ? "approved" : "review";
      return { ...candidate, titleIdentityMatch, relevanceScore: score.relevanceScore, qualityScore: score.qualityScore, identityScore: score.identityScore, visualMatchScore: score.visualMatchScore, referenceSignals: score.referenceSignals, visualRole: score.visualRole, identityConflicts: score.identityConflicts, duplicateOf: score.duplicateOf, watermarkDetected: score.watermarkDetected, rightsRisk: score.rightsRisk, usageStatus, recommended: usageStatus === "approved", reason: score.duplicateOf ? `${score.reason} · 중복 후보 ${score.duplicateOf}` : score.reason };
    }).filter((candidate) => scores.has(candidate.id)
      ? candidate.identityScore >= 0.62 && candidate.visualMatchScore >= 0.62 && candidate.relevanceScore >= 0.65 && !candidate.identityConflicts.length
      : candidate.titleIdentityMatch)
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || (b.identityScore + b.visualMatchScore) - (a.identityScore + a.visualMatchScore) || (b.relevanceScore + b.qualityScore) - (a.relevanceScore + a.qualityScore))
      .slice(0, 8);

    return NextResponse.json({ query: queries.join(" | "), configuredSources, candidates });
  } catch (error) {
    console.error("Artist image search failed", error);
    return NextResponse.json({ error: "아티스트 이미지 검색을 완료하지 못했습니다." }, { status: 502 });
  }
}
