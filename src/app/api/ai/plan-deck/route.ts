import { GoogleGenAI, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { bookingConditionBullets, hasConfirmedBookingConditions } from "@/features/profile-export/pptx/booking-conditions";

export const runtime = "nodejs";
export const maxDuration = 300;

async function withGeminiAvailabilityRetry<T>(operation: () => Promise<T>) {
  const delays = [700, 1600];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
      const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (attempt >= delays.length || status !== 503 && !message.includes("unavailable") && !message.includes("high demand")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

const slideSchema = z.object({
  type: z.enum(["cover", "about", "strengths", "program", "team", "gallery", "career", "contact"]),
  eyebrow: z.string(),
  title: z.string(),
  body: z.string(),
  bullets: z.array(z.string()),
  imageRefs: z.array(z.string()),
  imagePurpose: z.string(),
  careerIndexes: z.array(z.number().int().min(0)),
  layout: z.enum(["full_bleed", "split_left", "split_right", "editorial", "timeline", "gallery"]),
});

const planSchema = z.object({
  narrative: z.string(),
  visualDirection: z.string(),
  slides: z.array(slideSchema),
});

function describeGeminiFailure(error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.toLowerCase();
  if (status === 401 || status === 403 || message.includes("api_key_invalid") || message.includes("api key not valid") || message.includes("permission_denied")) {
    return { code: "GEMINI_AUTH_FAILED", status: 503, error: "Vercel의 Gemini API 키가 유효하지 않습니다. 환경변수 GEMINI_API_KEY를 로컬과 같은 키로 다시 저장한 뒤 재배포해 주세요." };
  }
  if (status === 429 || message.includes("resource_exhausted") || message.includes("quota")) {
    return { code: "GEMINI_QUOTA_EXCEEDED", status: 503, error: "Gemini 무료 사용량 또는 호출 한도를 초과했습니다. 잠시 후 다시 시도하거나 API 사용량을 확인해 주세요." };
  }
  if (status === 404 || message.includes("not found") || message.includes("model") && message.includes("support")) {
    return { code: "GEMINI_MODEL_NOT_AVAILABLE", status: 503, error: "설정된 Gemini 모델을 사용할 수 없습니다. Vercel의 GEMINI_MODEL 값을 확인해 주세요." };
  }
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return { code: "DECK_RESPONSE_INVALID", status: 502, error: "Gemini 응답 형식이 불완전했습니다. 다시 시도해 주세요." };
  }
  return { code: "DECK_PLANNING_FAILED", status: 502, error: "Gemini가 PPT 구성을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요." };
}

interface AssetInput {
  id: string;
  kind: "representative" | "performance" | "generated" | "pdf_visual";
  visualType?: "photo" | "graphic";
  visualRole?: "portrait" | "stage" | "poster" | "history" | "other" | "exclude";
  pageNumber?: number;
  dataUrl: string;
  sourceUrl?: string;
  sourceTitle?: string;
  origin?: "representative" | "upload" | "web" | "pdf" | "ai";
  qualityScore?: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

interface FactInput {
  index?: number;
  date?: string;
  title?: string;
  organization?: string;
  category?: "career" | "performance" | "award" | "media";
  pageNumber?: number;
  sourceUrl?: string;
  sourceName?: string;
}

const DECK_PROMPT_VERSION = "ppt-director-v2";

const copyBudgets = {
  cover: { title: 26, body: 42, bullets: 0, bullet: 0 },
  about: { title: 32, body: 105, bullets: 3, bullet: 38 },
  strengths: { title: 32, body: 0, bullets: 3, bullet: 48 },
  program: { title: 32, body: 46, bullets: 6, bullet: 36 },
  team: { title: 32, body: 46, bullets: 4, bullet: 42 },
  gallery: { title: 32, body: 42, bullets: 0, bullet: 0 },
  career: { title: 32, body: 0, bullets: 0, bullet: 0 },
  contact: { title: 30, body: 60, bullets: 2, bullet: 48 },
} as const;

function compactText(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!max || text.length <= max) return max ? text : "";
  const words = text.split(" ");
  let result = "";
  for (const word of words) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > max - 1) break;
    result = next;
  }
  return result ? `${result.replace(/[.,·;:!?-]+$/, "").trim()}…` : words[0];
}

function cleanFactTitle(fact?: FactInput, max = 22) {
  const title = String(fact?.title || "")
    .replace(/(?:19|20)\d{2}(?:[.\-/년월일\s]\d{1,2})*/g, "")
    .replace(/^(주요\s*)?(경력|공연|활동|수상|선정|방송|언론)\s*[:·|｜-]?\s*/i, "")
    .replace(/^[-–—,.:·\s]+|[-–—,.:·\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return compactText(title, max);
}

function galleryFactCopy(fact?: FactInput) {
  if (!fact) return { title: "현장에서 확인하는 대표 활동", body: "" };
  const label = cleanFactTitle(fact, 26);
  const title = fact.category === "award"
    ? "공식 수상으로 확인된 활동 성과"
    : fact.category === "media"
      ? "방송과 음원으로 이어진 대외 활동"
      : /공연|무대|콘서트|축제|페스티벌/.test(label) && !/사진|캡처|스크린샷/.test(label)
        ? label
        : /촬영|뮤직비디오|앨범|싱글/.test(label)
          ? "콘텐츠로 확장한 대표 활동"
          : "현장에서 확인하는 대표 활동";
  return { title, body: compactText([label, fact.date, fact.organization].filter(Boolean).join(" · "), 42) };
}

function careerSectionTitle(categories: Set<FactInput["category"]>) {
  if (categories.has("award") && categories.has("performance")) return "대표 무대와 공식 성과";
  if (categories.has("award")) return "수상 및 선정 이력";
  if (categories.has("performance")) return "대표 공연 및 활동";
  if (categories.has("media")) return "방송 및 언론 기록";
  return "주요 활동 이력";
}

function distinctCareerSectionTitle(baseTitle: string, occurrence: number) {
  if (!occurrence) return baseTitle;
  const alternatives: Record<string, string[]> = {
    "대표 무대와 공식 성과": ["무대 경험을 뒷받침하는 성과", "공연과 수상으로 확인한 활동 범위"],
    "수상 및 선정 이력": ["공식 성과와 대외 인정", "주요 수상으로 확인한 경쟁력"],
    "대표 공연 및 활동": ["축제·공연장 주요 활동", "현장에서 쌓아 온 무대 경험"],
    "방송 및 언론 기록": ["미디어 출연과 대외 활동", "방송 기록으로 보는 활동 범위"],
    "주요 활동 이력": ["협업 범위를 보여주는 주요 경력", "지속적인 활동과 프로젝트 경험"],
  };
  return alternatives[baseTitle]?.[(occurrence - 1) % alternatives[baseTitle].length] || baseTitle;
}

function purposeFactPriority(fact: FactInput, purpose: string) {
  const category = fact.category || "career";
  const weights = /공공|기관/.test(purpose)
    ? { award: 0, performance: 1, career: 2, media: 3 }
    : /기업|브랜드/.test(purpose)
      ? { media: 0, performance: 1, career: 2, award: 3 }
      : /축제|페스티벌|공연장|극장/.test(purpose)
        ? { performance: 0, award: 1, media: 2, career: 3 }
        : { performance: 0, award: 1, career: 2, media: 3 };
  const year = Number(String(fact.date || "").match(/(?:19|20)\d{2}/)?.[0] || 0);
  return (weights[category] ?? 3) * 10000 - year;
}

function paginateFactIndexes(indexes: number[], factsByIndex: Map<number, FactInput>, pageCount: number) {
  const categoryOrder = [...new Set(indexes.map((index) => factsByIndex.get(index)?.category || "career"))];
  const groups = categoryOrder.map((category) => indexes.filter((index) => (factsByIndex.get(index)?.category || "career") === category));
  const pages: number[][] = [];
  groups.forEach((group) => {
    if (pages.length < pageCount && group.length) pages.push(group.splice(0, 8));
  });
  const leftovers = groups.flat();
  while (leftovers.length && pages.length < pageCount) pages.push(leftovers.splice(0, 8));
  leftovers.forEach((factIndex) => {
    const target = pages.find((page) => page.length < 8);
    if (target) target.push(factIndex);
  });
  return pages.slice(0, pageCount);
}

function proposalBullets(profile: Record<string, unknown>) {
  const confirmedConditions = bookingConditionBullets(profile);
  if (confirmedConditions.length) return confirmedConditions;
  const extractedFacts = Array.isArray(profile.extractedFacts) ? profile.extractedFacts as Array<Record<string, unknown>> : [];
  const extractedValues = (type: string) => extractedFacts
    .filter((item) => item.type === type)
    .map((item) => String(item.value || "").trim())
    .filter(Boolean);
  const configurations = extractedValues("program_configuration");
  const repertoire = extractedValues("repertoire");
  const strengths = Array.isArray(profile.strengths) ? profile.strengths.map(String).filter(Boolean) : [];
  const generatedStrengths = Array.isArray(profile.generatedStrengths) ? profile.generatedStrengths.map(String).filter(Boolean) : [];
  const strength = generatedStrengths[0] || strengths[0] || String(profile.tagline || "");
  const proposal = [
    `무대 구성 · ${configurations[0] || [profile.primaryField, profile.secondaryField].filter(Boolean).join(" · ")}`,
    repertoire.length ? `대표 레퍼토리 · ${repertoire.slice(0, 2).join(" · ")}` : strength ? `관객 경험 · ${strength}` : "",
    `제안 범위 · ${[profile.purpose, profile.region].filter(Boolean).join(" · ")}`,
  ].filter((item) => item && !item.endsWith("· "));
  return proposal.map((item) => compactText(item, 48)).slice(0, 3);
}

function buildDeckPlanningPrompt(profile: Record<string, unknown>, targetPageCount: number, requiredGallerySlides: number, requiredCareerSlides: number, requiredProgramSlides: number, requiredTeamSlides: number, validFactIndexes: number[]) {
  const purpose = String(profile.purpose || "공연·행사 제안");
  return `역할: 당신은 문화예술인 섭외 제안서를 설계하는 시니어 프레젠테이션 디렉터입니다.

커뮤니케이션 과업:
- 독자는 '${purpose}' 담당자입니다.
- 독자가 30초 안에 아티스트의 정체성, 제안 가능한 무대, 행사 적합성, 공식 활동 근거를 파악하고 실제 문의하도록 만드세요.
- 사진 모음이나 이력서가 아니라 '왜 이 아티스트를 선택해야 하는가'에 답하는 제출용 포트폴리오를 기획하세요.

사실성 절대 규칙:
- profile, careers, extractedFacts, pdfPageText, 이미지 메타데이터에 명시된 사실만 사용하세요.
- 성과, 관객 반응, 공연 규모, 프로그램, 공연 시간, 출연 인원, 장비 조건을 추측하거나 꾸며내지 마세요.
- careers의 원래 index ${JSON.stringify(validFactIndexes)}를 career 슬라이드 전체에 중복·누락 없이 한 번씩 배치하세요.
- 사진과 경력을 연결할 때는 PDF pageNumber가 같거나 sourceUrl·sourceTitle에 직접 일치 근거가 있을 때만 gallery.careerIndexes에 넣으세요. 직접 근거가 없으면 빈 배열로 두고 특정 공연명을 추측하지 마세요.

서사 구조:
1. cover: 이름과 제안 목적을 한 번에 기억시키는 최소한의 표지
2. about: 소개문과 강한 공식 근거 2~3개로 정체성 설명
3. strengths: 고객이 선택 가능한 무대 구성 또는 확인된 섭외 조건
4. program: 실제 자료에서 추출된 공연 가능 곡·작품·레퍼토리를 선택지로 제시
5. team: 실제 자료에서 추출된 듀오·트리오·밴드 등 출연 구성을 선택지로 제시
6. gallery: 서로 다른 실제 무대 장면으로 현장 실행력 제시
7. career: 방송·공연·수상·주요 활동을 주제별로 정리한 공식 근거
8. contact: 일정·출연 조건 문의를 요청하는 명확한 행동 유도

슬라이드 역할 규칙:
- 정확히 ${targetPageCount}장을 반환하고 cover로 시작해 contact로 끝내세요.
- cover, about, strengths, contact는 각각 정확히 1장입니다.
- program은 정확히 ${requiredProgramSlides}장입니다. extractedFacts의 repertoire만 사용해 장르·작품 선택지를 정리하세요.
- team은 정확히 ${requiredTeamSlides}장입니다. extractedFacts의 program_configuration만 사용해 출연 구성과 인원 선택지를 정리하세요.
- gallery는 정확히 ${requiredGallerySlides}장입니다. 한 장에 자동역할=stage인 실제 사진 1장만 사용하고, 각 페이지는 서로 다른 고객용 결론을 말해야 합니다.
- career는 정확히 ${requiredCareerSlides}장이고 한 장당 최대 8개 경력을 사용합니다. 6개 이상이면 두 열로 배치할 수 있도록 항목을 짧게 쓰고, 카테고리별로 묶으며 연속 페이지 제목을 반복하지 마세요.
- cover/about/program/team/contact의 careerIndexes는 빈 배열, strengths는 관련 근거 1~3개, gallery는 직접 연결된 근거 0~1개, career는 해당 페이지 사실 index를 사용하세요.

이미지 규칙:
- 같은 imageRefs ID를 전체 PPT에서 한 번만 사용하세요.
- portrait는 cover 또는 about, stage photo는 about·strengths·gallery, poster/history graphic은 career 보조 근거에만 사용하세요.
- 포스터·연혁표·수상자료·문서 전체 캡처·콜라주를 gallery나 표지 배경으로 확대하지 마세요.
- graphic은 비율을 보존하는 프레임, photo는 자연스러운 크롭을 전제로 합니다.
- full_bleed는 고해상도 가로 stage 사진에만 제안할 수 있습니다. 확신이 없으면 split_left 또는 split_right를 선택하세요.

최종 원고 규칙:
- 화면에 보이는 모든 문장은 고객에게 그대로 전달할 최종 문장입니다.
- PHOTO BRIEF, VERIFIED, 이미지 준비, 사실 확인 필요, 원문 페이지, 내부 메모 같은 제작 문구를 쓰지 마세요.
- 추상적인 '전문성·완성도·신뢰·몰입도·차별화·최적'을 반복하지 말고 실제 경력이나 확인된 조건으로 말하세요.
- 제목은 페이지의 결론이어야 하며 '주요 활동', '대표 사진' 같은 단순 분류명만 쓰지 마세요.
- 강제 줄바꿈 문자를 넣지 마세요. 문장을 짧게 쓰고 같은 단어나 문장을 반복하지 마세요.

절대 분량 제한(한글·공백 포함):
- cover: title 26자, body 42자, bullets 0개
- about: title 32자, body 105자, bullets 최대 3개·각 38자
- strengths: title 32자, body 없음, bullets 정확히 3개·각 48자
- program: title 32자, body 46자, bullets 최대 6개·각 36자
- team: title 32자, body 46자, bullets 최대 4개·각 42자
- gallery: title 32자, body 42자, bullets 0개, imageRefs 정확히 1개
- career: title 32자, body·bullets 없음, careerIndexes 최대 8개
- contact: title 30자, body 60자, bullets 최대 2개·각 48자

프로필 사실:
${JSON.stringify(profile)}`;
}

function evidenceTokens(fact?: FactInput) {
  return [fact?.title, fact?.organization, fact?.date]
    .flatMap((value) => String(value || "").replace(/[^0-9a-z가-힣\s]/gi, " ").split(/\s+/))
    .filter((token) => token.length >= 2);
}

function hasSpecificEvidence(slide: z.infer<typeof slideSchema>, factsByIndex: Map<number, FactInput>) {
  if (!slide.careerIndexes.length) return false;
  const copy = `${slide.title} ${slide.body} ${slide.bullets.join(" ")}`.replace(/\s+/g, " ");
  return slide.careerIndexes.some((index) => evidenceTokens(factsByIndex.get(index)).some((token) => copy.includes(token)));
}

function isDirectAssetFactMatch(asset: AssetInput, fact?: FactInput) {
  if (!fact) return false;
  if (asset.pageNumber && fact.pageNumber && asset.pageNumber === fact.pageNumber) return true;
  const assetUrl = String(asset.sourceUrl || "").trim().replace(/\/$/, "");
  const factUrl = String(fact.sourceUrl || "").trim().replace(/\/$/, "");
  return Boolean(assetUrl && factUrl && assetUrl === factUrl);
}

function canUseFullBleed(asset?: AssetInput) {
  if (!asset || asset.visualType === "graphic" || asset.visualRole !== "stage") return false;
  const width = Number(asset.pixelWidth || 0);
  const height = Number(asset.pixelHeight || 0);
  return width >= 1600 && height >= 900 && width / height >= 1.5;
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Gemini가 연결되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as { profile: Record<string, unknown> & { requestedPageCount?: number }; assets: AssetInput[] };
    const assets = (body.assets ?? []).slice(0, 24);
    const visualAssets = assets;
    const galleryVisualAssets = visualAssets.filter((asset) => asset.visualRole === "stage" && asset.visualType !== "graphic");
    const requestedPageCount = Math.max(8, Math.min(12, Number(body.profile.requestedPageCount) || 10));
    const extractedFacts = Array.isArray(body.profile.extractedFacts) ? body.profile.extractedFacts as Array<Record<string, unknown>> : [];
    const extractedValues = (type: string) => extractedFacts
      .filter((item) => item.type === type)
      .map((item) => String(item.value || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const repertoire = [...new Set(extractedValues("repertoire"))].slice(0, 6);
    const programConfigurations = [...new Set(extractedValues("program_configuration"))].slice(0, 4);
    const requiredProgramSlides = repertoire.length ? 1 : 0;
    const requiredTeamSlides = programConfigurations.length ? 1 : 0;
    const facts = Array.isArray(body.profile.careers) ? body.profile.careers as FactInput[] : [];
    const factIndexOf = (fact: FactInput, position: number) => Number.isInteger(fact.index) ? Number(fact.index) : position;
    const factsByIndex = new Map(facts.map((fact, position) => [factIndexOf(fact, position), fact]));
    const validFactIndexes = new Set(factsByIndex.keys());
    const fixedSlideCount = 4 + requiredProgramSlides + requiredTeamSlides;
    const requiredCareerSlides = Math.max(1, Math.min(requestedPageCount - fixedSlideCount, Math.ceil(facts.length / 8) || 1));
    const featureVisualCount = requiredProgramSlides + requiredTeamSlides;
    const availableGalleryVisualCount = Math.max(0, galleryVisualAssets.length - featureVisualCount);
    const requiredGallerySlides = Math.min(5, availableGalleryVisualCount, Math.max(0, requestedPageCount - fixedSlideCount - requiredCareerSlides));
    const targetPageCount = Math.min(requestedPageCount, fixedSlideCount + requiredCareerSlides + requiredGallerySlides);
    const parts: Part[] = [{ text: buildDeckPlanningPrompt(body.profile, targetPageCount, requiredGallerySlides, requiredCareerSlides, requiredProgramSlides, requiredTeamSlides, [...validFactIndexes]) }];

    assets.forEach((asset) => {
      const match = asset.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!match) return;
      parts.push({ text: `이미지 후보 ID=${asset.id}, 종류=${asset.kind}, 자동역할=${asset.visualRole || "미분류"}, 수집경로=${asset.origin || "unknown"}${typeof asset.qualityScore === "number" ? `, 사전품질점수=${Math.round(asset.qualityScore * 100)}` : ""}${asset.pixelWidth && asset.pixelHeight ? `, 해상도=${asset.pixelWidth}x${asset.pixelHeight}` : ""}${asset.pageNumber ? `, PDF ${asset.pageNumber}페이지` : ""}${asset.sourceTitle ? `, 출처=${asset.sourceTitle}` : ""}` });
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await withGeminiAvailabilityRetry(() => ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(planSchema),
        temperature: 0.25,
        maxOutputTokens: 16384,
      },
    }));
    const plan = planSchema.parse(JSON.parse(response.text || "{}"));
    if (plan.slides[0]?.type !== "cover") {
      plan.slides.unshift({ type: "cover", eyebrow: "ARTIST PROFILE", title: String(body.profile.artistName || "ARTIST"), body: String(body.profile.tagline || ""), bullets: [], imageRefs: assets[0] ? [assets[0].id] : [], imagePurpose: "대표 이미지를 활용한 정체성 전달", careerIndexes: [], layout: "editorial" });
    }
    if (plan.slides.at(-1)?.type !== "contact") {
      plan.slides.push({ type: "contact", eyebrow: "CONTACT", title: "다음 무대를 함께 만들겠습니다", body: [body.profile.contact, body.profile.videoUrl, body.profile.region].filter(Boolean).join(" · "), bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" });
    }
    plan.slides = [
      plan.slides[0],
      ...plan.slides.slice(1, -1).filter((slide) => slide.type !== "cover" && slide.type !== "contact"),
      plan.slides.at(-1)!,
    ];
    if (!plan.slides.some((slide) => slide.type === "about")) {
      plan.slides.splice(1, 0, { type: "about", eyebrow: "아티스트 소개", title: String(body.profile.tagline || body.profile.artistName || "아티스트의 정체성"), body: String(body.profile.introduction || ""), bullets: [body.profile.primaryField, body.profile.region].filter(Boolean).map(String).slice(0, 2), imageRefs: [], imagePurpose: "대표 활동을 보여주는 사진", careerIndexes: [], layout: "split_right" });
    }
    let aboutSeen = false;
    plan.slides = plan.slides.filter((slide) => slide.type !== "about" || !aboutSeen && (aboutSeen = true));
    let strengthsSeen = false;
    plan.slides = plan.slides.filter((slide) => slide.type !== "strengths" || !strengthsSeen && (strengthsSeen = true));
    if (!strengthsSeen) {
      const insertAt = plan.slides.findIndex((slide) => slide.type === "career" || slide.type === "contact");
      plan.slides.splice(insertAt >= 0 ? insertAt : plan.slides.length - 1, 0, { type: "strengths", eyebrow: "제안 무대", title: "행사 목적에 맞춘 무대 제안", body: "", bullets: proposalBullets(body.profile), imageRefs: [], imagePurpose: "제안 무대를 보여주는 대표 활동 사진", careerIndexes: [], layout: "editorial" });
    }
    let programSeen = false;
    plan.slides = plan.slides.filter((slide) => slide.type !== "program" || requiredProgramSlides > 0 && !programSeen && (programSeen = true));
    if (requiredProgramSlides && !programSeen) {
      const insertAt = plan.slides.findIndex((slide) => slide.type === "gallery" || slide.type === "career" || slide.type === "contact");
      plan.slides.splice(insertAt >= 0 ? insertAt : plan.slides.length - 1, 0, { type: "program", eyebrow: "공연 프로그램", title: "행사 성격에 맞춰 선택하는 레퍼토리", body: "자료에서 확인된 공연 가능 곡과 작품을 중심으로 구성합니다.", bullets: repertoire, imageRefs: [], imagePurpose: "레퍼토리의 장르와 무대 분위기를 보여주는 실제 활동 사진", careerIndexes: [], layout: "editorial" });
    }
    const programSlide = plan.slides.find((slide) => slide.type === "program");
    if (programSlide) {
      programSlide.eyebrow = "공연 프로그램";
      programSlide.title = "행사 성격에 맞춰 선택하는 레퍼토리";
      programSlide.body = "자료에서 확인된 공연 가능 곡과 작품을 중심으로 구성합니다.";
      programSlide.bullets = repertoire;
      programSlide.careerIndexes = [];
    }
    let teamSeen = false;
    plan.slides = plan.slides.filter((slide) => slide.type !== "team" || requiredTeamSlides > 0 && !teamSeen && (teamSeen = true));
    if (requiredTeamSlides && !teamSeen) {
      const insertAt = plan.slides.findIndex((slide) => slide.type === "gallery" || slide.type === "career" || slide.type === "contact");
      plan.slides.splice(insertAt >= 0 ? insertAt : plan.slides.length - 1, 0, { type: "team", eyebrow: "출연 구성", title: "공간과 예산에 맞춰 고르는 팀 구성", body: "자료에서 확인된 실제 출연 형태만 제안합니다.", bullets: programConfigurations, imageRefs: [], imagePurpose: "출연 인원과 팀 구성을 한눈에 보여주는 단체 활동 사진", careerIndexes: [], layout: "editorial" });
    }
    const teamSlide = plan.slides.find((slide) => slide.type === "team");
    if (teamSlide) {
      teamSlide.eyebrow = "출연 구성";
      teamSlide.title = "공간과 예산에 맞춰 고르는 팀 구성";
      teamSlide.body = "자료에서 확인된 실제 출연 형태만 제안합니다.";
      teamSlide.bullets = programConfigurations;
      teamSlide.careerIndexes = [];
    }
    let galleryCount = 0;
    plan.slides = plan.slides.filter((slide) => slide.type !== "gallery" || galleryCount++ < requiredGallerySlides);
    let gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    while (gallerySlides.length < requiredGallerySlides) {
      plan.slides.splice(plan.slides.length - 1, 0, { type: "gallery", eyebrow: "대표 활동", title: "실제 활동에서 확인하는 아티스트의 색", body: "", bullets: [], imageRefs: [], imagePurpose: "고객이 현장 규모와 구성을 판단할 수 있는 대표 활동 사진", careerIndexes: [], layout: "gallery" });
      gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    }
    let careerCount = 0;
    plan.slides = plan.slides.filter((slide) => slide.type !== "career" || careerCount++ < requiredCareerSlides);
    let careerSlides = plan.slides.filter((slide) => slide.type === "career");
    while (careerSlides.length < requiredCareerSlides) {
      const careerSlide = { type: "career" as const, eyebrow: "주요 경력", title: "주요 활동과 성과", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "timeline" as const };
      plan.slides.splice(plan.slides.length - 1, 0, careerSlide);
      careerSlides = plan.slides.filter((slide) => slide.type === "career");
    }

    const purpose = String(body.profile.purpose || "");
    const factIndexes = facts.map((fact, position) => ({ index: factIndexOf(fact, position), priority: purposeFactPriority(fact, purpose) })).sort((a, b) => a.priority - b.priority).map(({ index }) => index);
    const careerPageIndexes = paginateFactIndexes(factIndexes, factsByIndex, requiredCareerSlides);
    const careerTitleCounts = new Map<string, number>();
    careerSlides.forEach((slide, index) => {
      const indexes = careerPageIndexes[index] || [];
      const categories = new Set(indexes.map((factIndex) => factsByIndex.get(factIndex)?.category));
      slide.careerIndexes = indexes;
      slide.eyebrow = categories.has("award") ? "수상 및 선정" : categories.has("performance") ? "주요 공연 및 활동" : categories.has("media") ? "방송 및 언론" : "주요 경력";
      const baseTitle = careerSectionTitle(categories);
      const occurrence = careerTitleCounts.get(baseTitle) || 0;
      careerTitleCounts.set(baseTitle, occurrence + 1);
      slide.title = distinctCareerSectionTitle(baseTitle, occurrence);
      slide.body = "";
      slide.bullets = [];
      slide.imageRefs = [];
      slide.layout = "timeline";
    });

    while (plan.slides.length > targetPageCount) {
      const removableIndex = plan.slides.findIndex((slide, index) => index > 0 && index < plan.slides.length - 1
         && slide.type !== "career"
         && slide.type !== "strengths"
         && slide.type !== "about"
         && slide.type !== "program"
         && slide.type !== "team"
        && (slide.type !== "gallery" || plan.slides.filter((item) => item.type === "gallery").length > requiredGallerySlides));
      if (removableIndex < 0) break;
      plan.slides.splice(removableIndex, 1);
    }
    plan.slides.forEach((slide) => {
      if (slide.type === "career") return;
      if (slide.type === "strengths") {
        const existing = [...new Set(slide.careerIndexes)].filter((index) => validFactIndexes.has(index)).slice(0, 3);
        slide.careerIndexes = [...existing, ...factIndexes.filter((index) => !existing.includes(index))].slice(0, Math.min(3, factIndexes.length));
        return;
      }
      slide.careerIndexes = [];
    });

    const purposeTitle = compactText(`${String(body.profile.purpose || "행사")}에 맞춘 ${String(body.profile.primaryField || "문화예술")} 무대`, 32);
    const cover = plan.slides[0];
    cover.eyebrow = "아티스트 섭외 제안";
    cover.title = String(body.profile.artistName || cover.title || "ARTIST");
    cover.body = purposeTitle;
    const about = plan.slides.find((slide) => slide.type === "about");
    if (about && body.profile.tagline) about.title = String(body.profile.tagline);
    const proposal = plan.slides.find((slide) => slide.type === "strengths");
    if (proposal) {
      const hasBookingConditions = hasConfirmedBookingConditions(body.profile);
      proposal.eyebrow = hasBookingConditions ? "섭외 조건" : "제안 무대";
      proposal.title = hasBookingConditions ? "확인된 섭외 조건 요약" : purposeTitle;
      proposal.body = "";
      proposal.bullets = proposalBullets(body.profile);
    }
    const validIds = new Set(assets.map((asset) => asset.id));
    const contact = plan.slides.at(-1)!;
    gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    const featureSlides = [programSlide, teamSlide].filter((slide): slide is z.infer<typeof slideSchema> => Boolean(slide));
    const assignedImageIds = new Set<string>();
    const pickUnused = (...predicates: Array<(asset: AssetInput) => boolean>) => {
      for (const predicate of predicates) {
        const selected = visualAssets.find((asset) => !assignedImageIds.has(asset.id) && predicate(asset));
        if (selected) return selected;
      }
      return undefined;
    };
    const assignImage = (slide: z.infer<typeof slideSchema> | undefined, asset: AssetInput | undefined, purposeText: string) => {
      if (!slide) return;
      slide.imageRefs = asset ? [asset.id] : [];
      slide.imagePurpose = purposeText;
      if (asset) assignedImageIds.add(asset.id);
    };
    const remainingStageCount = () => galleryVisualAssets.filter((asset) => !assignedImageIds.has(asset.id)).length;

    const coverAsset = pickUnused(
      (asset) => asset.kind === "representative" && asset.visualType !== "graphic" && (asset.visualRole !== "stage" || remainingStageCount() > gallerySlides.length + featureSlides.length),
      (asset) => asset.visualRole === "portrait" && asset.visualType !== "graphic",
      (asset) => asset.origin === "representative" && asset.visualType !== "graphic" && (asset.visualRole !== "stage" || remainingStageCount() > gallerySlides.length + featureSlides.length),
    );
    assignImage(cover, coverAsset, "아티스트의 정체성을 한 번에 전달하는 대표 사진");
    cover.layout = canUseFullBleed(coverAsset) ? "full_bleed" : "split_right";

    const aboutAsset = pickUnused(
      (asset) => asset.visualRole === "portrait" && asset.visualType !== "graphic",
      (asset) => asset.visualRole === "other" && asset.visualType !== "graphic",
      (asset) => asset.visualRole === "stage" && asset.visualType !== "graphic" && remainingStageCount() > gallerySlides.length + featureSlides.length,
    );
    assignImage(about, aboutAsset, "소개문과 실제 활동 인상을 함께 전달하는 사진");
    if (about) about.layout = "split_left";

    featureSlides.forEach((slide, index) => {
      const selected = pickUnused(
        (asset) => asset.visualRole === "stage" && asset.visualType !== "graphic",
        (asset) => asset.visualRole === "other" && asset.visualType !== "graphic",
      );
      assignImage(slide, selected, slide.type === "program" ? "레퍼토리의 장르와 무대 분위기를 보여주는 실제 활동 사진" : "출연 인원과 팀 구성을 한눈에 보여주는 단체 활동 사진");
      slide.layout = index % 2 ? "split_left" : "split_right";
    });

    const genericGalleryTitles = ["무대에서 드러나는 아티스트의 색", "현장 호흡으로 완성되는 무대", "공간의 분위기를 이끄는 장면", "관객과 만나는 대표 무대", "행사의 인상을 남기는 순간"];
    gallerySlides.forEach((slide, index) => {
      const selected = pickUnused((asset) => asset.visualRole === "stage" && asset.visualType !== "graphic");
      assignImage(slide, selected, "고객이 현장 분위기와 무대 적합성을 판단할 수 있는 실제 활동 사진");
      const matchedFact = selected
        ? [...factsByIndex.entries()].find(([, fact]) => isDirectAssetFactMatch(selected, fact))
        : undefined;
      slide.careerIndexes = matchedFact ? [matchedFact[0]] : [];
      const copy = galleryFactCopy(matchedFact?.[1]);
      slide.title = matchedFact ? copy.title : genericGalleryTitles[index % genericGalleryTitles.length];
      slide.body = matchedFact ? copy.body : "실제 활동 사진으로 무대 분위기와 표현 방식을 확인할 수 있습니다.";
      slide.layout = canUseFullBleed(selected) && index % 3 === 0 ? "full_bleed" : index % 2 ? "split_left" : "split_right";
    });

    assignImage(proposal, pickUnused(
      (asset) => asset.visualRole === "stage" && asset.visualType !== "graphic",
      (asset) => asset.visualType !== "graphic" && asset.visualRole !== "portrait",
    ), "제안 가능한 무대 구성과 현장 실행력을 보여주는 활동 사진");
    if (proposal) proposal.layout = "split_right";

    careerSlides.forEach((slide, index) => {
      const selected = slide.careerIndexes.length > 5 ? undefined : pickUnused(
        (asset) => asset.visualType === "graphic" && (asset.visualRole === "history" || asset.visualRole === "poster"),
        (asset) => asset.visualRole === "poster" || asset.visualRole === "history",
        (asset) => asset.visualType !== "graphic" && asset.visualRole !== "portrait",
      );
      assignImage(slide, selected, "해당 경력의 맥락을 보조하는 포스터·연혁 자료 또는 활동 사진");
      slide.layout = selected ? index % 2 ? "split_left" : "split_right" : "timeline";
    });

    assignImage(contact, pickUnused(
      (asset) => asset.visualRole === "portrait" && asset.visualType !== "graphic",
      (asset) => asset.visualType !== "graphic",
    ), "제안 검토 후에도 아티스트를 기억하게 만드는 마무리 사진");
    contact.eyebrow = "섭외 문의";
    contact.title = "가능 일정과 출연 조건을 확인해 보세요";
    contact.body = [body.profile.primaryField, body.profile.purpose, body.profile.region].filter(Boolean).join(" · ");
    contact.bullets = [body.profile.contact, body.profile.videoUrl].filter(Boolean).map(String).slice(0, 2);
    contact.layout = "split_right";
    const seenCopy = new Set<string>();
    plan.slides.forEach((slide) => {
      const budget = copyBudgets[slide.type];
      slide.imageRefs = slide.imageRefs.filter((id) => validIds.has(id)).slice(0, 1);
      slide.eyebrow = compactText(slide.eyebrow, 28).toUpperCase();
      slide.title = compactText(slide.title, budget.title);
      slide.body = budget.body ? compactText(slide.body, budget.body) : "";
      slide.bullets = budget.bullets ? slide.bullets.map((item) => compactText(item, budget.bullet)).filter(Boolean).slice(0, budget.bullets) : [];
      const bodyKey = slide.body.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
      if (bodyKey && seenCopy.has(bodyKey)) slide.body = "";
      else if (bodyKey) seenCopy.add(bodyKey);
      slide.bullets = slide.bullets.filter((item) => {
        const key = item.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
        if (!key || seenCopy.has(key)) return false;
        seenCopy.add(key);
        return true;
      });
      const careerIndexLimit = slide.type === "career" ? 8 : slide.type === "strengths" ? 3 : slide.type === "gallery" ? 1 : 0;
      slide.careerIndexes = [...new Set(slide.careerIndexes)].filter((index) => validFactIndexes.has(index)).slice(0, careerIndexLimit);
    });
    const coveredIndexes = new Set(plan.slides.flatMap((slide) => slide.type === "career" ? slide.careerIndexes : []));
    const awardIndexes = facts.map((fact, position) => fact.category === "award" ? factIndexOf(fact, position) : -1).filter((index) => index >= 0);
    const coverage = facts.length ? coveredIndexes.size / facts.length : 1;
    const awardCoverage = awardIndexes.length ? awardIndexes.filter((index) => coveredIndexes.has(index)).length / awardIndexes.length : 1;
    const structureScore = plan.slides.length === targetPageCount
      && plan.slides[0]?.type === "cover"
      && plan.slides.at(-1)?.type === "contact"
      && plan.slides.filter((slide) => slide.type === "about").length === 1
      && plan.slides.filter((slide) => slide.type === "strengths").length === 1
      && plan.slides.filter((slide) => slide.type === "program").length === requiredProgramSlides
      && plan.slides.filter((slide) => slide.type === "team").length === requiredTeamSlides
      && plan.slides.filter((slide) => slide.type === "gallery").length === requiredGallerySlides
      && plan.slides.filter((slide) => slide.type === "career").length === requiredCareerSlides
      ? 10 : 0;
    const usedImageIds = plan.slides.flatMap((slide) => slide.imageRefs);
    const uniqueImageScore = new Set(usedImageIds).size === usedImageIds.length ? 10 : 0;
    const textFits = plan.slides.every((slide) => {
      const budget = copyBudgets[slide.type];
      return slide.title.length <= budget.title && (!budget.body || slide.body.length <= budget.body) && slide.bullets.length <= budget.bullets && slide.bullets.every((item) => item.length <= budget.bullet);
    });
    const evidenceSlides = plan.slides.filter((slide) => slide.type === "strengths" || slide.type === "career");
    const evidenceConnected = !facts.length || evidenceSlides.every((slide) => slide.careerIndexes.some((index) => validFactIndexes.has(index)));
    const proposalSlide = plan.slides.find((slide) => slide.type === "strengths");
    const expectedProposalLabels = proposalBullets(body.profile).map((bullet) => bullet.split("·")[0].trim());
    const coverReady = [body.profile.primaryField, body.profile.purpose].filter(Boolean).some((value) => `${plan.slides[0]?.title} ${plan.slides[0]?.body}`.includes(String(value)));
    const proposalReady = Boolean(proposalSlide
      && expectedProposalLabels.every((label) => proposalSlide.bullets.some((bullet) => bullet.startsWith(`${label} ·`))));
    const galleryReady = plan.slides.filter((slide) => slide.type === "gallery").every((slide) => slide.imageRefs.length === 1
      && (!slide.careerIndexes.length || hasSpecificEvidence(slide, factsByIndex)));
    const contactReady = /일정|출연|조건|문의/.test(plan.slides.at(-1)?.title || "");
    const decisionReadiness = [coverReady, proposalReady, galleryReady, contactReady].filter(Boolean).length / 4;
    const finalCopyOnly = plan.slides.every((slide) => !/PHOTO\s*BRIEF|VERIFIED|이미지\s*(준비|삽입|교체)|사실\s*확인\s*필요|입력해\s*주세요/i.test(`${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`));
    const qualityScore = Math.min(100, Math.round(structureScore + coverage * 25 + awardCoverage * 10 + uniqueImageScore + (textFits ? 10 : 0) + (evidenceConnected ? 10 : 0) + decisionReadiness * 15 + (finalCopyOnly ? 10 : 0)));
    if (qualityScore < 90) throw new Error(`PPT 품질 점수 미달: ${qualityScore}`);
    return NextResponse.json({ plan, mode: "ai", provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash", promptVersion: DECK_PROMPT_VERSION, qualityScore, coveredFactCount: coveredIndexes.size, totalFactCount: facts.length });
  } catch (error) {
    console.error("Gemini deck planning failed", error);
    const failure = describeGeminiFailure(error);
    return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
  }
}
