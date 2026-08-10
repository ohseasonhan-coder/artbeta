import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

type ResearchSource = "namuwiki" | "otr" | "showgle";

interface SearchResult {
  id: string;
  source: ResearchSource;
  sourceLabel: string;
  verificationTier: "platform" | "reference";
  title: string;
  snippet: string;
  sourceUrl: string;
}

const sourceConfigs: Array<{ source: ResearchSource; label: string; domain: string; verificationTier: "platform" | "reference" }> = [
  { source: "namuwiki", label: "나무위키", domain: "namu.wiki", verificationTier: "reference" },
  { source: "otr", label: "OTR", domain: "otr.co.kr", verificationTier: "platform" },
  { source: "showgle", label: "쇼글", domain: "showgle.co.kr", verificationTier: "platform" },
];

const reviewSchema = z.object({
  matches: z.array(z.object({
    id: z.string(),
    relevant: z.boolean(),
    reason: z.string(),
    facts: z.array(z.object({
      type: z.enum(["career", "performance", "award", "media", "introduction"]),
      date: z.string(),
      title: z.string(),
      organization: z.string(),
      description: z.string(),
      confidence: z.number().min(0).max(1),
    })).max(8),
  })),
});

async function searchSource(artistName: string, config: typeof sourceConfigs[number]): Promise<SearchResult[]> {
  const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
  url.searchParams.set("key", process.env.GOOGLE_SEARCH_API_KEY || "");
  url.searchParams.set("cx", process.env.GOOGLE_SEARCH_ENGINE_ID || "");
  url.searchParams.set("q", `"${artistName}" site:${config.domain}`);
  url.searchParams.set("safe", "active");
  url.searchParams.set("num", "5");
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`${config.label} search ${response.status}`);
  const data = await response.json() as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.items ?? []).flatMap((item, index) => {
    if (!item.link) return [];
    try {
      const hostname = new URL(item.link).hostname.replace(/^www\./, "");
      if (hostname !== config.domain && !hostname.endsWith(`.${config.domain}`)) return [];
    } catch {
      return [];
    }
    return [{
      id: `${config.source}-${index}`,
      source: config.source,
      sourceLabel: config.label,
      verificationTier: config.verificationTier,
      title: (item.title || `${config.label} 검색 결과`).replace(/\s+/g, " ").trim(),
      snippet: (item.snippet || "").replace(/\s+/g, " ").trim(),
      sourceUrl: item.link,
    }];
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { artistName?: string; primaryField?: string; region?: string; careers?: Array<{ year?: string; title?: string; organization?: string }> };
    const artistName = body.artistName?.trim() || "";
    if (!artistName) return NextResponse.json({ error: "활동명을 먼저 입력해 주세요." }, { status: 400 });
    if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_ENGINE_ID) {
      return NextResponse.json({ error: "Google 검색 API가 설정되지 않았습니다.", code: "GOOGLE_SEARCH_NOT_CONFIGURED" }, { status: 503 });
    }

    const searched = await Promise.allSettled(sourceConfigs.map((config) => searchSource(artistName, config)));
    const sources = searched.flatMap((result) => result.status === "fulfilled" ? result.value : []).slice(0, 15);
    if (!sources.length) return NextResponse.json({ sources: [], message: "나무위키·OTR·쇼글에서 관련 공개 검색 결과를 찾지 못했습니다." });

    let reviews = new Map<string, z.infer<typeof reviewSchema>["matches"][number]>();
    let aiReviewed = false;
    if (process.env.GEMINI_API_KEY) {
      try {
        const knownCareers = (body.careers ?? []).filter((career) => career.title || career.organization).slice(0, 12);
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
          contents: [{ role: "user", parts: [{ text: `문화예술인 '${artistName}'의 공개 검색 결과를 검토하세요. 분야는 '${body.primaryField || "미지정"}', 지역은 '${body.region || "미지정"}'입니다. 기존 경력은 ${JSON.stringify(knownCareers)}입니다. 아래에는 Google 검색이 반환한 나무위키·OTR·쇼글의 제목과 검색 요약문만 있습니다. 이름이 같은 다른 사람일 수 있으므로 분야·기관·작품·지역이 맞지 않으면 relevant=false로 두세요. 검색 요약문에 명시된 사실만 facts로 구조화하고 추측하거나 새로운 경력·날짜·수상 내역을 만들지 마세요. 나무위키는 사용자 편집 참고 자료이므로 confidence를 최대 0.65로 제한하세요. OTR·쇼글도 플랫폼 등록 정보일 뿐 공식 증명은 아니므로 최대 0.78로 제한하세요. 각 사실은 사용자가 출처를 열어 확인해야 합니다. 검색 결과: ${JSON.stringify(sources)}` }] }],
          config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(reviewSchema), temperature: 0.05 },
        });
        const parsed = reviewSchema.parse(JSON.parse(response.text || "{}"));
        reviews = new Map(parsed.matches.map((match) => [match.id, match]));
        aiReviewed = true;
      } catch (error) {
        console.warn("Artist background review failed; returning source links only", error);
      }
    }

    const candidates = sources.map((source) => {
      const review = reviews.get(source.id);
      return {
        ...source,
        relevant: review?.relevant ?? false,
        reason: review?.reason || "출처 페이지에서 동일 인물과 사실 여부를 직접 확인해 주세요.",
        facts: review?.facts ?? [],
      };
    }).sort((a, b) => Number(b.relevant) - Number(a.relevant) || b.facts.length - a.facts.length);

    return NextResponse.json({ candidates, aiReviewed, searchedSources: sourceConfigs.map((source) => source.label) });
  } catch (error) {
    console.error("Artist background search failed", error);
    return NextResponse.json({ error: "외부 프로필 기록 검색을 완료하지 못했습니다." }, { status: 502 });
  }
}
