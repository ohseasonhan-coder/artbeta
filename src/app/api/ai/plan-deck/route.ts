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
  pageNumber?: number;
  dataUrl: string;
  sourceUrl?: string;
  sourceTitle?: string;
  origin?: "representative" | "upload" | "web" | "pdf" | "ai";
  qualityScore?: number;
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
  const candidate = text.slice(0, max - 1);
  const breakAt = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf(" · "), candidate.lastIndexOf(" "));
  return `${candidate.slice(0, breakAt > max * 0.55 ? breakAt : max - 1).trim()}…`;
}

function splitText(value: string, max: number) {
  const chunks: string[] = [];
  let rest = value.replace(/\s+/g, " ").trim();
  if (!rest || !max) return rest ? [rest] : [];
  while (rest.length > max) {
    const candidate = rest.slice(0, max + 1);
    const breakAt = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("다. "), candidate.lastIndexOf(" · "), candidate.lastIndexOf(" "));
    const cut = breakAt > max * 0.55 ? breakAt + (candidate.slice(breakAt, breakAt + 2) === ". " ? 1 : 0) : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function paginateSlide(slide: z.infer<typeof slideSchema>) {
  const budget = copyBudgets[slide.type];
  const bodyLimit = budget.body;
  const bodyChunks = bodyLimit ? splitText(slide.body, bodyLimit) : slide.body ? [slide.body] : [];
  const bulletChunks = budget.bullet
    ? slide.type === "contact"
      ? slide.bullets.slice(0, 2).map((item) => compactText(item, budget.bullet))
      : slide.bullets.flatMap((item) => splitText(item, budget.bullet))
    : [];
  const pageCount = Math.max(1, bodyChunks.length, budget.bullets ? Math.ceil(bulletChunks.length / budget.bullets) : 1);
  if (pageCount === 1) return [slide];
  return Array.from({ length: pageCount }, (_, index): z.infer<typeof slideSchema> => ({
    ...slide,
    type: slide.type === "cover" && index > 0 ? "about" : slide.type,
    eyebrow: index ? `${slide.eyebrow || "PROFILE"} · CONTINUED` : slide.eyebrow,
    title: index ? `${compactText(slide.title, 26)} · 계속` : slide.title,
    body: bodyChunks[index] || "",
    bullets: budget.bullets ? bulletChunks.slice(index * budget.bullets, index * budget.bullets + budget.bullets) : [],
    imageRefs: index ? [] : slide.imageRefs,
    imagePurpose: index ? "" : slide.imagePurpose,
    layout: index ? "editorial" : slide.layout,
  }));
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
    const facts = Array.isArray(body.profile.careers) ? body.profile.careers as Array<{ index?: number; category?: string }> : [];
    const requiredCareerSlides = Math.max(1, Math.ceil(facts.length / 6));
    const requiredGallerySlides = Math.min(2, galleryVisualAssets.length);
    const targetPageCount = Math.min(32, Math.max(requestedPageCount, 4 + requiredCareerSlides + requiredGallerySlides));
    const parts: Part[] = [{
      text: `당신은 문화예술인 섭외·제안용 포트폴리오를 설계하는 시니어 아트디렉터입니다. 사진 모음이나 활동 자료집이 아니라, 담당자가 이 예술인을 기억하고 바로 섭외하도록 만드는 심플하고 강한 PPT를 기획하세요.\n\n커뮤니케이션 목표: 담당자가 예술인의 정체성, 대표 무대, 검증된 활동을 빠르게 이해하고 마지막 장에서 바로 문의하게 만듭니다.\n\n중요: careers는 직접 입력한 경력과 PDF에서 추출해 승인한 수상·공연·활동·언론 사실을 합친 전체 근거입니다. 모든 인덱스를 career 슬라이드에 한 번씩 배치하세요. extractedFacts와 PDF 텍스트는 소개와 강점을 구체화하는 근거로만 사용합니다. 이미지 후보는 전부 쓸 필요가 없으며, 구도·해상도·정체성·무대 맥락이 가장 강한 것만 고르세요.\n\n구성 규칙:\n- 정확히 ${targetPageCount}장의 slides를 반환합니다. 첫 장은 cover, 마지막 장은 contact입니다.\n- gallery 타입은 사진 갤러리가 아니라 '대표 장면' 슬라이드입니다. 정확히 ${requiredGallerySlides}장만 사용하고 각 장에 가장 강한 이미지 1개와 메시지 1개만 둡니다.\n- 전체 PPT에서 이미지 자산은 최대 4개만 사용합니다. 같은 이미지, 비슷한 구도, 품질이 낮은 이미지, 단순 기록용 포스터와 원문 캡처는 과감히 제외합니다.\n- career 슬라이드는 최소 ${requiredCareerSlides}장이며 한 장당 최대 6개입니다. careers의 0~${Math.max(0, facts.length - 1)} 인덱스를 중복·누락 없이 담습니다.\n- 한 슬라이드는 하나의 주장만 전달합니다. 같은 소개·수식어를 반복하지 않습니다.\n- 제목은 분류명이 아니라 실제 활동 근거에서 나온 짧고 구체적인 결론으로 씁니다.\n- 표지는 활동명과 한 줄 태그라인만 둡니다.\n- 사진은 배경이나 콜라주로 쓰지 않고 넓은 독립 프레임에 한 장씩 배치합니다. 사진은 자연스럽게 크롭하고, 꼭 필요한 포스터·그래픽만 전체를 표시합니다.\n- 경력은 careerIndexes로만 연결하며 사실을 만들거나 과장하지 않습니다.\n- contact는 행동을 요청하는 제목, 실제 연락처와 대표 영상 링크만 담습니다.\n\n슬라이드별 절대 분량 제한(한글·공백 포함):\n- cover: title 26자, body 42자, bullets 없음\n- about: title 32자, body 105자, bullets 최대 2개·각 30자\n- strengths: title 32자, body 없음, bullets 3개·각 34자\n- gallery: title 32자, body 42자, bullets 없음, 이미지 정확히 1개\n- career: title 32자, body·bullets 없음, 근거 최대 6개\n- contact: title 30자, body 60자, bullets 최대 2개·각 48자\n\n프로필 사실:\n${JSON.stringify(body.profile)}`,
    }];

    assets.forEach((asset) => {
      const match = asset.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!match) return;
      parts.push({ text: `이미지 후보 ID=${asset.id}, 종류=${asset.kind}, 수집경로=${asset.origin || "unknown"}${typeof asset.qualityScore === "number" ? `, 사전품질점수=${Math.round(asset.qualityScore * 100)}` : ""}${asset.pageNumber ? `, PDF ${asset.pageNumber}페이지` : ""}${asset.sourceTitle ? `, 출처=${asset.sourceTitle}` : ""}` });
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
    let galleryCount = 0;
    plan.slides = plan.slides.filter((slide) => slide.type !== "gallery" || galleryCount++ < requiredGallerySlides);
    let gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    while (gallerySlides.length < requiredGallerySlides) {
      plan.slides.splice(plan.slides.length - 1, 0, { type: "gallery", eyebrow: "SIGNATURE MOMENT", title: gallerySlides.length ? "무대가 남긴 또 하나의 장면" : "이 무대를 기억하게 만드는 순간", body: "", bullets: [], imageRefs: [], imagePurpose: "대표 활동을 한눈에 보여주는 강한 사진 한 장", careerIndexes: [], layout: "gallery" });
      gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    }
    let careerCount = 0;
    plan.slides = plan.slides.filter((slide) => slide.type !== "career" || careerCount++ < requiredCareerSlides);
    let careerSlides = plan.slides.filter((slide) => slide.type === "career");
    while (careerSlides.length < requiredCareerSlides) {
      const careerSlide = { type: "career" as const, eyebrow: "VERIFIED PROFILE", title: "문서로 확인된 주요 활동", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "timeline" as const };
      plan.slides.splice(plan.slides.length - 1, 0, careerSlide);
      careerSlides = plan.slides.filter((slide) => slide.type === "career");
    }

    const categoryPriority: Record<string, number> = { award: 0, performance: 1, media: 2, career: 3 };
    const factIndexes = facts.map((fact, index) => ({ index, priority: categoryPriority[fact.category || "career"] ?? 3 })).sort((a, b) => a.priority - b.priority).map(({ index }) => index);
    const careerTitleCounts: Record<string, number> = {};
    const careerTitles: Record<string, string[]> = {
      award: ["수상으로 확인된 전문성", "선정과 성과가 만든 신뢰"],
      performance: ["주요 무대에서 쌓은 경험", "현장에서 이어온 활동"],
      media: ["방송과 언론이 기록한 활동", "대외 기록으로 확인된 이력"],
      career: ["지속적으로 이어온 주요 경력", "다음 활동으로 연결된 이력"],
    };
    careerSlides.forEach((slide, index) => {
      const indexes = factIndexes.slice(index * 6, index * 6 + 6);
      const categories = new Set(indexes.map((factIndex) => facts[factIndex]?.category));
      slide.careerIndexes = indexes;
      slide.eyebrow = categories.has("award") ? "AWARDS & RECOGNITION" : categories.has("performance") ? "SELECTED ACTIVITIES" : categories.has("media") ? "MEDIA & PRESS" : "SELECTED HISTORY";
      const primaryCategory = categories.has("award") ? "award" : categories.has("performance") ? "performance" : categories.has("media") ? "media" : "career";
      const titleIndex = careerTitleCounts[primaryCategory] ?? 0;
      slide.title = careerTitles[primaryCategory][titleIndex % careerTitles[primaryCategory].length];
      careerTitleCounts[primaryCategory] = titleIndex + 1;
      slide.body = "";
      slide.bullets = [];
      slide.imageRefs = [];
      slide.layout = "timeline";
    });

    const validIds = new Set(assets.map((asset) => asset.id));
    const cover = plan.slides.find((slide) => slide.type === "cover");
    const about = plan.slides.find((slide) => slide.type === "about");
    const contact = plan.slides.at(-1)!;
    gallerySlides = plan.slides.filter((slide) => slide.type === "gallery");
    const assignedImages = new Set<string>();
    const assignImage = (slide: z.infer<typeof slideSchema> | undefined, fallbacks: AssetInput[]) => {
      if (!slide) return;
      const preferred = slide.imageRefs.map((id) => assets.find((asset) => asset.id === id)).find((asset) => asset && !assignedImages.has(asset.id));
      const selected = preferred || fallbacks.find((asset) => !assignedImages.has(asset.id));
      slide.imageRefs = selected ? [selected.id] : [];
      if (selected) assignedImages.add(selected.id);
    };
    assignImage(cover, visualAssets);
    assignImage(about, visualAssets.slice(1));
    gallerySlides.forEach((slide, index) => assignImage(slide, [...galleryVisualAssets.slice(index), ...visualAssets]));
    plan.slides.filter((slide) => !["cover", "about", "gallery"].includes(slide.type)).forEach((slide) => { slide.imageRefs = []; });
    contact.eyebrow = "BOOKING & CONTACT";
    contact.title = "공연·행사 섭외를 문의해 주세요";
    contact.body = [body.profile.primaryField, body.profile.purpose, body.profile.region].filter(Boolean).join(" · ");
    contact.bullets = [body.profile.contact || "연락 가능한 전화번호 또는 이메일을 입력해 주세요", body.profile.videoUrl].filter(Boolean).map(String).slice(0, 2);
    contact.imageRefs = [];
    contact.imagePurpose = "";
    contact.layout = "editorial";
    const usedIds = new Set<string>();
    const seenCopy = new Set<string>();
    plan.slides.forEach((slide) => {
      const budget = copyBudgets[slide.type];
      slide.imageRefs = slide.imageRefs.filter((id) => validIds.has(id) && !usedIds.has(id)).slice(0, 1);
      slide.imageRefs.forEach((id) => usedIds.add(id));
      slide.eyebrow = compactText(slide.eyebrow, 28).toUpperCase();
      slide.title = compactText(slide.title, budget.title);
      slide.body = budget.body ? slide.body.replace(/\s+/g, " ").trim() : "";
      slide.bullets = budget.bullets ? slide.bullets.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean) : [];
      const bodyKey = slide.body.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
      if (bodyKey && seenCopy.has(bodyKey)) slide.body = "";
      else if (bodyKey) seenCopy.add(bodyKey);
      slide.bullets = slide.bullets.filter((item) => {
        const key = item.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
        if (!key || seenCopy.has(key)) return false;
        seenCopy.add(key);
        return true;
      });
      slide.careerIndexes = [...new Set(slide.careerIndexes)].filter((index) => index < facts.length).slice(0, 6);
    });
    plan.slides = plan.slides.flatMap(paginateSlide);
    const coveredIndexes = new Set(plan.slides.flatMap((slide) => slide.type === "career" ? slide.careerIndexes : []));
    const awardIndexes = facts.map((fact, index) => fact.category === "award" ? index : -1).filter((index) => index >= 0);
    const coverage = facts.length ? coveredIndexes.size / facts.length : 1;
    const awardCoverage = awardIndexes.length ? awardIndexes.filter((index) => coveredIndexes.has(index)).length / awardIndexes.length : 1;
    const structureScore = plan.slides[0]?.type === "cover" && plan.slides.at(-1)?.type === "contact" ? 20 : 0;
    const qualityScore = Math.round(structureScore + coverage * 45 + awardCoverage * 15 + 10 + 10);
    if (qualityScore < 90) throw new Error(`PPT 품질 점수 미달: ${qualityScore}`);
    return NextResponse.json({ plan, mode: "ai", provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash", qualityScore, coveredFactCount: coveredIndexes.size, totalFactCount: facts.length });
  } catch (error) {
    console.error("Gemini deck planning failed", error);
    const failure = describeGeminiFailure(error);
    return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
  }
}
