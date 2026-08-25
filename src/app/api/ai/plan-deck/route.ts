import { GoogleGenAI, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { bookingConditionBullets, hasConfirmedBookingConditions } from "@/features/profile-export/pptx/booking-conditions";

export const runtime = "nodejs";
export const maxDuration = 300;

const slideSchema = z.object({
  type: z.enum(["cover", "about", "strengths", "gallery", "career", "contact"]),
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
}

interface FactInput {
  index?: number;
  date?: string;
  title?: string;
  organization?: string;
  category?: "career" | "performance" | "award" | "media";
}

const copyBudgets = {
  cover: { title: 26, body: 42, bullets: 0, bullet: 0 },
  about: { title: 32, body: 105, bullets: 3, bullet: 38 },
  strengths: { title: 32, body: 0, bullets: 3, bullet: 48 },
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

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Gemini가 연결되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as { profile: Record<string, unknown> & { requestedPageCount?: number }; assets: AssetInput[] };
    const assets = (body.assets ?? []).slice(0, 24);
    const visualAssets = assets;
    const galleryVisualAssets = visualAssets.slice(2);
    const requestedPageCount = Math.max(8, Math.min(12, Number(body.profile.requestedPageCount) || 10));
    const facts = Array.isArray(body.profile.careers) ? body.profile.careers as FactInput[] : [];
    const factIndexOf = (fact: FactInput, position: number) => Number.isInteger(fact.index) ? Number(fact.index) : position;
    const factsByIndex = new Map(facts.map((fact, position) => [factIndexOf(fact, position), fact]));
    const validFactIndexes = new Set(factsByIndex.keys());
    const requiredCareerSlides = Math.max(1, Math.min(4, Math.ceil(facts.length / 5)));
    const requiredGallerySlides = Math.min(5, galleryVisualAssets.length, Math.max(0, requestedPageCount - 4 - requiredCareerSlides));
    const targetPageCount = Math.min(requestedPageCount, 4 + requiredCareerSlides + requiredGallerySlides);
    const parts: Part[] = [{
      text: `당신은 문화예술인 섭외·제안용 포트폴리오를 설계하는 시니어 아트디렉터입니다. 사진 모음이나 활동 자료집이 아니라, 제안서를 받는 고객이 이 예술인을 자신의 행사에 섭외했을 때 무엇을 얻는지 이해하고 실제 문의하도록 만드는 PPT를 기획하세요.\n\n커뮤니케이션 목표: ${String(body.profile.purpose || "공연·행사 제안")} 담당자가 30초 안에 아티스트의 정체성, 제안 가능한 무대, 행사 적합성, 실제 활동 근거를 확인하고 마지막 장에서 일정과 출연 조건을 문의하게 만듭니다.\n\n중요: careers는 직접 입력한 경력과 PDF·외부 링크에서 추출해 승인한 수상·공연·활동·언론 중 고객 설득력이 높은 대표 근거입니다. 전달된 모든 career의 원래 index를 career 슬라이드에 한 번씩 배치하세요. extractedFacts와 PDF 텍스트는 소개와 제안 무대를 구체화하는 참고 근거로 사용하되, 자료를 나열하거나 사실에 없는 프로그램·성과·관객 반응·공연 시간·인원·장비를 만들지 마세요.\n\n최종 원고 원칙:\n- 화면에 보이는 모든 문장은 제안처에 그대로 전달할 최종 원고입니다. PHOTO BRIEF, VERIFIED, 이미지 준비, 사실 확인 필요, 내부 메모 같은 제작 지시를 절대 쓰지 않습니다. imagePurpose만 내부 배치 정보로 씁니다.\n- cover는 아티스트명과 '${String(body.profile.purpose || "행사")}'에 맞춘 분야·무대 제안을 한 줄로 씁니다. 수상명이나 경력명을 억지로 표지 문장에 붙이지 않습니다.\n- about은 tagline·introduction을 바탕으로 이 아티스트만의 무대 정체성을 설명합니다.\n- strengths 슬라이드는 정확히 1장 사용합니다. performanceDuration·castSize·technicalRequirements 중 확인된 값이 하나라도 있으면 제목을 '확인된 섭외 조건 요약'으로 쓰고, 확인된 항목을 '공연 시간 ·', '출연 인원 ·', '기술·장비 ·' 순서로 먼저 배치합니다. 남는 bullet만 '무대 구성 ·', '관객 경험 ·', '제안 범위 ·' 중 확인된 정보로 채웁니다. 조건이 전혀 없으면 기존 제안 무대 역할로 사용합니다.\n- gallery는 이미지와 연결되는 실제 공연명·기관·연도를 제목이나 본문에 씁니다. 사진이 무엇을 보여주는지 고객이 바로 이해해야 합니다.\n- career는 경력을 해석한 광고 문구가 아니라 '대표 무대와 공식 성과', '수상 및 선정 이력'처럼 빠르게 훑는 사실 페이지로 만듭니다.\n- contact 제목은 '가능 일정과 출연 조건을 확인해 보세요'처럼 다음 행동을 직접 요청합니다.\n- '검증된', '신뢰', '완성도', '전문성', '몰입도', '차별화', '최적'만으로 결론을 만들지 않습니다. 같은 가치 표현을 반복하지 않습니다.\n\n구성 규칙:\n- 정확히 ${targetPageCount}장의 slides를 반환합니다. 첫 장은 cover, 마지막 장은 contact입니다.\n- 같은 imageRefs ID를 두 슬라이드에 절대 반복하지 않습니다. 사진이 부족하면 imageRefs를 비웁니다.\n- 이미지가 2장 이상이면 about 슬라이드를 반드시 포함합니다. gallery 타입은 사진 갤러리가 아니라 한 가지 활동을 보여주는 '대표 장면'이며 정확히 ${requiredGallerySlides}장 사용합니다.\n- career 슬라이드는 정확히 ${requiredCareerSlides}장이며 한 장당 최대 6개입니다. careers의 원래 index ${JSON.stringify([...validFactIndexes])}를 중복·누락 없이 담습니다.\n- 모든 슬라이드는 근거가 되는 careerIndexes를 최소 1개 지정하되, 경력명을 모든 제목에 반복해서 넣지는 않습니다.\n- 사진은 배경이나 콜라주로 쓰지 않고 독립 프레임에 배치합니다. 사진은 자연스럽게 크롭하고, 포스터·그래픽은 전체를 표시합니다.\n- contact는 실제 연락처와 대표 영상 링크를 담습니다.\n- 텍스트가 길면 단어 중간을 자르지 말고 띄어쓰기 경계에서 줄바꿈합니다. 글자가 슬라이드 밖으로 나가는 것은 절대 금지입니다.\n\n슬라이드별 절대 분량 제한(한글·공백 포함):\n- cover: title 26자, body 42자, bullets 없음\n- about: title 32자, body 105자, bullets 최대 2개·각 30자\n- strengths: title 32자, body 없음, bullets 3개·각 34자\n- gallery: title 32자, body 42자, bullets 없음, 이미지 정확히 1개\n- career: title 32자, body·bullets 없음, 근거 최대 6개\n- contact: title 30자, body 60자, bullets 최대 2개·각 48자\n\n프로필 사실:\n${JSON.stringify(body.profile)}`,
    }];
    if (parts[0].text) {
      parts[0].text = parts[0].text
        .replace("about: title 32자, body 105자, bullets 최대 2개·각 30자", "about: title 32자, body 105자, bullets 최대 3개·각 38자")
        .replace("사진은 배경이나 콜라주로 쓰지 않고 독립 프레임에 배치합니다.", "사진은 기본적으로 독립 프레임에 배치하고, 고해상도 가로 무대사진만 배경으로 허용합니다.");
    }
    parts.push({ text: "추가 절대 규칙: about에는 소개문을 반복하지 말고 실제 수상·대표 공연·방송 등 가장 강한 근거 3개를 bullets로 배치하세요. strengths에는 추출된 repertoire와 program_configuration이 있으면 고객이 선택할 수 있는 대표 레퍼토리와 무대 구성으로 우선 사용하세요. 여러 사진을 이어 붙인 콜라주·분할 화면·영상 썸네일 합성은 인물사진이나 배경으로 사용하지 마세요. 단, 동일 아티스트의 공연·포스터 이력을 정리한 고해상도 history 또는 poster 자산은 경력 증빙 페이지의 비율 보존 프레임에서 한 번 사용할 수 있습니다. 저해상도 이미지는 전체 화면으로 확대하지 마세요. 세로 인물사진과 포스터는 비율 보존 프레임을 사용하고, 고해상도 가로 무대사진만 텍스트 안전 영역과 어두운 오버레이가 있는 배경 후보로 허용합니다. 원본 파일명·사진 정리 문구·OCR 조각을 gallery 제목으로 사용하지 말고 고객이 이해할 수 있는 활동 의미로 다시 작성하세요." });

    assets.forEach((asset) => {
      const match = asset.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!match) return;
      parts.push({ text: `이미지 후보 ID=${asset.id}, 종류=${asset.kind}, 자동역할=${asset.visualRole || "미분류"}, 수집경로=${asset.origin || "unknown"}${typeof asset.qualityScore === "number" ? `, 사전품질점수=${Math.round(asset.qualityScore * 100)}` : ""}${asset.pageNumber ? `, PDF ${asset.pageNumber}페이지` : ""}${asset.sourceTitle ? `, 출처=${asset.sourceTitle}` : ""}` });
      parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(planSchema),
        temperature: 0.25,
        maxOutputTokens: 16384,
      },
    });
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
    let strengthsSeen = false;
    plan.slides = plan.slides.filter((slide) => slide.type !== "strengths" || !strengthsSeen && (strengthsSeen = true));
    if (!strengthsSeen) {
      const insertAt = plan.slides.findIndex((slide) => slide.type === "career" || slide.type === "contact");
      plan.slides.splice(insertAt >= 0 ? insertAt : plan.slides.length - 1, 0, { type: "strengths", eyebrow: "제안 무대", title: "행사 목적에 맞춘 무대 제안", body: "", bullets: proposalBullets(body.profile), imageRefs: [], imagePurpose: "제안 무대를 보여주는 대표 활동 사진", careerIndexes: [], layout: "editorial" });
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
    careerSlides.forEach((slide, index) => {
      const indexes = factIndexes.slice(index * 5, index * 5 + 5);
      const categories = new Set(indexes.map((factIndex) => factsByIndex.get(factIndex)?.category));
      slide.careerIndexes = indexes;
      slide.eyebrow = categories.has("award") ? "수상 및 선정" : categories.has("performance") ? "주요 공연 및 활동" : categories.has("media") ? "방송 및 언론" : "주요 경력";
      slide.title = careerSectionTitle(categories);
      slide.body = "";
      slide.bullets = [];
      slide.imageRefs = [];
      slide.layout = "timeline";
    });

    while (plan.slides.length > targetPageCount) {
      const removableIndex = plan.slides.findIndex((slide, index) => index > 0 && index < plan.slides.length - 1
        && slide.type !== "career"
        && slide.type !== "strengths"
        && (slide.type !== "gallery" || plan.slides.filter((item) => item.type === "gallery").length > requiredGallerySlides));
      if (removableIndex < 0) break;
      plan.slides.splice(removableIndex, 1);
    }
    if (factIndexes.length) {
      let evidenceCursor = 0;
      plan.slides.forEach((slide) => {
        if (slide.type === "career") return;
        const requestedEvidenceCount = slide.type === "strengths" ? Math.min(3, factIndexes.length) : 1;
        const existing = [...new Set(slide.careerIndexes)].filter((index) => validFactIndexes.has(index)).slice(0, requestedEvidenceCount);
        while (existing.length < requestedEvidenceCount) {
          const candidate = factIndexes[evidenceCursor % factIndexes.length];
          evidenceCursor += 1;
          if (!existing.includes(candidate)) existing.push(candidate);
        }
        slide.careerIndexes = existing;
      });
    }

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
    plan.slides.filter((slide) => slide.type === "gallery").forEach((slide) => {
      const fact = slide.careerIndexes.map((index) => factsByIndex.get(index)).find(Boolean);
      const copy = galleryFactCopy(fact);
      slide.title = copy.title;
      slide.body = copy.body;
    });

    const validIds = new Set(assets.map((asset) => asset.id));
    const contact = plan.slides.at(-1)!;
    gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    const primaryAboutIndex = plan.slides.findIndex((slide) => slide.type === "about");
    let nextImageIndex = 0;
    plan.slides.forEach((slide, index) => {
      const preferredIndex = slide.type === "cover" ? 0 : index === primaryAboutIndex && visualAssets[1] ? 1 : nextImageIndex;
      const selected = visualAssets[preferredIndex];
      slide.imageRefs = selected ? [selected.id] : [];
      slide.imagePurpose ||= slide.type === "career" ? "해당 경력과 연결되는 현장 사진" : slide.type === "contact" ? "아티스트를 기억하게 만드는 마무리 사진" : "페이지 메시지를 뒷받침하는 활동 사진";
      slide.layout = index % 2 ? "split_right" : "split_left";
      if (selected) nextImageIndex = Math.max(nextImageIndex + 1, slide.type === "about" ? 2 : 1);
    });
    contact.eyebrow = "섭외 문의";
    contact.title = "가능 일정과 출연 조건을 확인해 보세요";
    contact.body = [body.profile.primaryField, body.profile.purpose, body.profile.region].filter(Boolean).join(" · ");
    contact.bullets = [body.profile.contact, body.profile.videoUrl].filter(Boolean).map(String).slice(0, 2);
    contact.imagePurpose ||= "아티스트를 기억하게 만드는 마무리 사진";
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
      slide.careerIndexes = [...new Set(slide.careerIndexes)].filter((index) => validFactIndexes.has(index)).slice(0, 6);
    });
    const coveredIndexes = new Set(plan.slides.flatMap((slide) => slide.type === "career" ? slide.careerIndexes : []));
    const awardIndexes = facts.map((fact, position) => fact.category === "award" ? factIndexOf(fact, position) : -1).filter((index) => index >= 0);
    const coverage = facts.length ? coveredIndexes.size / facts.length : 1;
    const awardCoverage = awardIndexes.length ? awardIndexes.filter((index) => coveredIndexes.has(index)).length / awardIndexes.length : 1;
    const structureScore = plan.slides[0]?.type === "cover" && plan.slides.at(-1)?.type === "contact" ? 15 : 0;
    const usedImageIds = plan.slides.flatMap((slide) => slide.imageRefs);
    const uniqueImageScore = new Set(usedImageIds).size === usedImageIds.length ? 10 : 0;
    const textFits = plan.slides.every((slide) => {
      const budget = copyBudgets[slide.type];
      return slide.title.length <= budget.title && (!budget.body || slide.body.length <= budget.body) && slide.bullets.length <= budget.bullets && slide.bullets.every((item) => item.length <= budget.bullet);
    });
    const evidenceConnected = !facts.length || plan.slides.every((slide) => slide.careerIndexes.some((index) => validFactIndexes.has(index)));
    const proposalSlide = plan.slides.find((slide) => slide.type === "strengths");
    const expectedProposalLabels = proposalBullets(body.profile).map((bullet) => bullet.split("·")[0].trim());
    const coverReady = [body.profile.primaryField, body.profile.purpose].filter(Boolean).some((value) => `${plan.slides[0]?.title} ${plan.slides[0]?.body}`.includes(String(value)));
    const proposalReady = Boolean(proposalSlide
      && expectedProposalLabels.every((label) => proposalSlide.bullets.some((bullet) => bullet.startsWith(`${label} ·`))));
    const galleryReady = plan.slides.filter((slide) => slide.type === "gallery").every((slide) => hasSpecificEvidence(slide, factsByIndex));
    const contactReady = /일정|출연|조건|문의/.test(plan.slides.at(-1)?.title || "") && Boolean(String(body.profile.contact || "").trim());
    const decisionReadiness = [coverReady, proposalReady, galleryReady, contactReady].filter(Boolean).length / 4;
    const finalCopyOnly = plan.slides.every((slide) => !/PHOTO\s*BRIEF|VERIFIED|이미지\s*(준비|삽입|교체)|사실\s*확인\s*필요|입력해\s*주세요/i.test(`${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`));
    const qualityScore = Math.round(structureScore + coverage * 30 + awardCoverage * 10 + uniqueImageScore + (textFits ? 10 : 0) + (evidenceConnected ? 10 : 0) + decisionReadiness * 15 + (finalCopyOnly ? 10 : 0));
    if (qualityScore < 90) throw new Error(`PPT 품질 점수 미달: ${qualityScore}`);
    return NextResponse.json({ plan, mode: "ai", provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash", qualityScore, coveredFactCount: coveredIndexes.size, totalFactCount: facts.length });
  } catch (error) {
    console.error("Gemini deck planning failed", error);
    const failure = describeGeminiFailure(error);
    return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
  }
}
