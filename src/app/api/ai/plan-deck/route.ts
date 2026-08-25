import { GoogleGenAI, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";

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
  about: { title: 32, body: 105, bullets: 2, bullet: 30 },
  strengths: { title: 32, body: 0, bullets: 3, bullet: 34 },
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

function factTitle(fact: FactInput | undefined, fallback: string) {
  const title = cleanFactTitle(fact, 22);
  return title ? compactText(`${title}를 포함한 주요 활동`, 32) : fallback;
}

function factClaim(fact: FactInput | undefined, fallback: string) {
  const title = cleanFactTitle(fact, 22);
  if (!title) return fallback;
  const ending = fact?.category === "award"
    ? "성과로 확인된 아티스트"
    : fact?.category === "performance"
      ? "무대 경험을 이어갑니다"
      : fact?.category === "media"
        ? "기록으로 만나는 아티스트"
        : "활동을 이어온 아티스트";
  return compactText(`${title}, ${ending}`, 32);
}

function factValueBullet(fact?: FactInput) {
  const title = cleanFactTitle(fact, 19);
  if (!title) return "";
  const value = fact?.category === "award"
    ? "공식 수상·선정"
    : fact?.category === "performance"
      ? "대표 무대 경험"
      : fact?.category === "media"
        ? "방송·언론 기록"
        : "주요 협업 경험";
  return compactText(`${title} · ${value}`, 34);
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
    const requestedPageCount = Math.max(5, Math.min(8, Number(body.profile.requestedPageCount) || 6));
    const facts = Array.isArray(body.profile.careers) ? body.profile.careers as FactInput[] : [];
    const factIndexOf = (fact: FactInput, position: number) => Number.isInteger(fact.index) ? Number(fact.index) : position;
    const factsByIndex = new Map(facts.map((fact, position) => [factIndexOf(fact, position), fact]));
    const validFactIndexes = new Set(factsByIndex.keys());
    const requiredCareerSlides = Math.max(1, Math.min(2, Math.ceil(facts.length / 6)));
    const requiredGallerySlides = Math.min(2, galleryVisualAssets.length, Math.max(0, requestedPageCount - 4 - requiredCareerSlides));
    const targetPageCount = requestedPageCount;
    const parts: Part[] = [{
      text: `당신은 문화예술인 섭외·제안용 포트폴리오를 설계하는 시니어 아트디렉터입니다. 사진 모음이나 활동 자료집이 아니라, 제안서를 받는 고객이 이 예술인을 선택해야 하는 이유를 빠르게 이해하고 문의하도록 만드는 심플하고 강한 PPT를 기획하세요.\n\n커뮤니케이션 목표: ${String(body.profile.purpose || "공연·행사 제안")} 담당자가 예술인의 정체성, 고객이 얻게 될 현장 가치, 실제 활동 근거를 이해하고 마지막 장에서 바로 문의하게 만듭니다. 모든 문장은 아티스트가 아니라 제안받는 고객의 판단을 돕는 언어로 작성합니다.\n\n중요: careers는 직접 입력한 경력과 PDF·외부 링크에서 추출해 승인한 수상·공연·활동·언론 중 고객 설득력이 높은 대표 근거입니다. 전달된 모든 career의 원래 index를 career 슬라이드에 한 번씩 배치하세요. extractedFacts와 PDF 텍스트는 소개와 강점을 구체화하는 참고 근거로 사용하되, 자료를 나열하거나 페이지 수를 늘리지 마세요. 전달된 이미지는 사용자 자료, PDF·PPTX에서 분리한 원본 이미지, 승인된 웹 이미지와 AI 연출 이미지입니다.\n\n최종 원고 원칙:\n- 화면에 보이는 모든 문장은 제안처에 그대로 전달할 최종 원고입니다. PHOTO BRIEF, VERIFIED, 이미지 준비, 사실 확인 필요, 내부 메모 같은 제작 지시를 절대 쓰지 않습니다. imagePurpose만 내부 배치 정보로 씁니다.\n- cover·about·strengths·gallery의 제목 또는 본문에는 careerIndexes로 연결한 실제 공연명, 수상명, 기관명, 장소명, 연도 중 하나를 반드시 그대로 포함합니다.\n- '검증된', '신뢰', '완성도', '전문성', '몰입도', '차별화', '최적'만으로 결론을 만들지 않습니다. 해당 단어를 쓰려면 같은 문장에 실제 활동명이나 기관명을 함께 씁니다.\n- 같은 가치 표현을 다른 슬라이드에서 반복하지 않습니다. 근거가 부족하면 과장된 광고 문구 대신 확인된 분야·지역·활동을 사실적으로 씁니다.\n\n구성 규칙:\n- 정확히 ${targetPageCount}장의 slides를 반환합니다. 첫 장은 cover, 마지막 장은 contact입니다.\n- 같은 imageRefs ID를 두 슬라이드에 절대 반복하지 않습니다. 사진이 부족하면 imageRefs를 비우고 imagePurpose에 고객이 준비할 사진을 구체적으로 씁니다.\n- 이미지가 2장 이상이면 about 슬라이드를 반드시 포함합니다. gallery 타입은 사진 갤러리가 아니라 고객에게 한 가지 현장 가치를 증명하는 '대표 장면'이며 정확히 ${requiredGallerySlides}장 사용합니다.\n- 경력·강점·연락처 페이지도 글을 왼쪽, 이미지를 오른쪽에 두는 균형 잡힌 분할 레이아웃을 사용합니다.\n- career 슬라이드는 정확히 ${requiredCareerSlides}장이며 한 장당 최대 6개입니다. 전달된 careers의 원래 index ${JSON.stringify([...validFactIndexes])}를 중복·누락 없이 담습니다.\n- career 이외의 모든 슬라이드도 customer value의 증거가 되는 careerIndexes를 최소 1개 지정합니다. 제목과 본문은 그 실제 근거가 고객에게 주는 이익을 해석한 문장이어야 하며, 근거에 없는 성과·효과를 만들지 않습니다.\n- 한 슬라이드는 고객의 질문 하나에 답합니다: 어떤 아티스트인가, 고객 행사에 어떤 가치를 주는가, 무엇으로 확인되는가, 어떻게 섭외하는가.\n- 강점은 추상적인 자기소개가 아니라 고객 관점의 효과와 선택 근거로 번역합니다. 확인되지 않은 성과는 만들지 않습니다.\n- 제목은 분류명이 아니라 실제 활동 근거가 고객의 선택에 주는 의미를 짧고 구체적인 결론으로 씁니다. 같은 소개·수식어를 반복하지 않습니다.\n- 표지는 활동명과 고객이 기억할 한 줄 가치만 둡니다.\n- 사진은 배경이나 콜라주로 쓰지 않고 독립 프레임에 배치합니다. 사진은 자연스럽게 크롭하고, 포스터·그래픽은 전체를 표시합니다.\n- 경력과 고객 가치의 근거는 careerIndexes로만 연결하며 사실을 만들거나 과장하지 않습니다.\n- contact는 고객의 다음 행동을 요청하는 제목, 실제 연락처와 대표 영상 링크만 담습니다.\n- 텍스트가 길면 단어 중간을 자르지 말고 띄어쓰기 경계에서 다음 페이지로 넘깁니다. 글자가 슬라이드 밖으로 나가는 것은 절대 금지입니다.\n\n슬라이드별 절대 분량 제한(한글·공백 포함):\n- cover: title 26자, body 42자, bullets 없음\n- about: title 32자, body 105자, bullets 최대 2개·각 30자\n- strengths: title 32자, body 없음, bullets 3개·각 34자\n- gallery: title 32자, body 42자, bullets 없음, 이미지 정확히 1개\n- career: title 32자, body·bullets 없음, 근거 최대 6개\n- contact: title 30자, body 60자, bullets 최대 2개·각 48자\n\n프로필 사실:\n${JSON.stringify(body.profile)}`,
    }];

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
    if (visualAssets.length > 1 && !plan.slides.some((slide) => slide.type === "about")) {
      plan.slides.splice(1, 0, { type: "about", eyebrow: "아티스트 소개", title: String(body.profile.tagline || body.profile.artistName || "아티스트의 정체성"), body: String(body.profile.introduction || ""), bullets: [body.profile.primaryField, body.profile.region].filter(Boolean).map(String).slice(0, 2), imageRefs: [], imagePurpose: "대표 활동을 보여주는 사진", careerIndexes: [], layout: "split_right" });
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

    const categoryPriority: Record<string, number> = { award: 0, performance: 1, media: 2, career: 3 };
    const factIndexes = facts.map((fact, position) => ({ index: factIndexOf(fact, position), priority: categoryPriority[fact.category || "career"] ?? 3 })).sort((a, b) => a.priority - b.priority).map(({ index }) => index);
    careerSlides.forEach((slide, index) => {
      const indexes = factIndexes.slice(index * 6, index * 6 + 6);
      const categories = new Set(indexes.map((factIndex) => factsByIndex.get(factIndex)?.category));
      slide.careerIndexes = indexes;
      slide.eyebrow = categories.has("award") ? "수상 및 선정" : categories.has("performance") ? "주요 공연 및 활동" : categories.has("media") ? "방송 및 언론" : "주요 경력";
      slide.title = factTitle(factsByIndex.get(indexes[0]), "주요 활동과 성과");
      slide.body = "";
      slide.bullets = [];
      slide.imageRefs = [];
      slide.layout = "timeline";
    });

    while (plan.slides.length > targetPageCount) {
      const removableIndex = plan.slides.findIndex((slide, index) => index > 0 && index < plan.slides.length - 1
        && slide.type !== "career"
        && (slide.type !== "gallery" || plan.slides.filter((item) => item.type === "gallery").length > requiredGallerySlides));
      if (removableIndex < 0) break;
      plan.slides.splice(removableIndex, 1);
    }
    while (plan.slides.length < targetPageCount) {
      plan.slides.splice(plan.slides.length - 1, 0, {
        type: "strengths",
        eyebrow: "선택 이유",
        title: "실제 활동으로 확인하는 세 가지 강점",
        body: "",
        bullets: Array.isArray(body.profile.strengths) ? body.profile.strengths.map(String).slice(0, 3) : [],
        imageRefs: [],
        imagePurpose: "행사 담당자가 현장 적합성을 판단할 수 있는 대표 활동 사진",
        careerIndexes: [],
        layout: "editorial",
      });
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
      plan.slides.forEach((slide) => {
        if (!["cover", "about", "strengths", "gallery"].includes(slide.type) || hasSpecificEvidence(slide, factsByIndex)) return;
        const linkedFacts = slide.careerIndexes.map((index) => factsByIndex.get(index)).filter((fact): fact is FactInput => Boolean(fact));
        const firstFact = linkedFacts[0];
        if (slide.type === "cover") slide.body = factClaim(firstFact, slide.body);
        if (slide.type === "about") slide.title = factClaim(firstFact, slide.title);
        if (slide.type === "gallery") slide.title = factClaim(firstFact, slide.title);
        if (slide.type === "strengths") slide.bullets = linkedFacts.map(factValueBullet).filter(Boolean).slice(0, 3);
      });
    }

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
    contact.title = compactText(`${String(body.profile.purpose || "다음 무대")}에 맞춘 ${String(body.profile.primaryField || "예술")} 제안`, 30);
    contact.body = [body.profile.primaryField, body.profile.purpose, body.profile.region].filter(Boolean).join(" · ");
    contact.bullets = [body.profile.contact || "연락 가능한 전화번호 또는 이메일을 입력해 주세요", body.profile.videoUrl].filter(Boolean).map(String).slice(0, 2);
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
    const specificitySlides = plan.slides.filter((slide) => ["cover", "about", "strengths", "gallery"].includes(slide.type));
    const specificity = !facts.length || !specificitySlides.length
      ? 1
      : specificitySlides.filter((slide) => hasSpecificEvidence(slide, factsByIndex)).length / specificitySlides.length;
    const finalCopyOnly = plan.slides.every((slide) => !/PHOTO\s*BRIEF|VERIFIED|이미지\s*(준비|삽입|교체)|사실\s*확인\s*필요/i.test(`${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`));
    const qualityScore = Math.round(structureScore + coverage * 30 + awardCoverage * 10 + uniqueImageScore + (textFits ? 10 : 0) + (evidenceConnected ? 10 : 0) + specificity * 15 + (finalCopyOnly ? 10 : 0));
    if (qualityScore < 90) throw new Error(`PPT 품질 점수 미달: ${qualityScore}`);
    return NextResponse.json({ plan, mode: "ai", provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash", qualityScore, coveredFactCount: coveredIndexes.size, totalFactCount: facts.length });
  } catch (error) {
    console.error("Gemini deck planning failed", error);
    const failure = describeGeminiFailure(error);
    return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
  }
}
