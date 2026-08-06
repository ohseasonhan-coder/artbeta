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
  kind: "representative" | "performance" | "pdf_page";
  pageNumber?: number;
  dataUrl: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

const copyBudgets = {
  cover: { title: 26, body: 55, bullets: 0, bullet: 0 },
  about: { title: 34, body: 160, bullets: 3, bullet: 34 },
  strengths: { title: 34, body: 0, bullets: 3, bullet: 42 },
  gallery: { title: 34, body: 70, bullets: 0, bullet: 0 },
  career: { title: 34, body: 70, bullets: 0, bullet: 0 },
  contact: { title: 30, body: 110, bullets: 2, bullet: 36 },
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
  const bodyLimit = slide.imageRefs.length && slide.type === "about" ? 110 : slide.imageRefs.length && slide.type === "contact" ? 85 : budget.body;
  const bodyChunks = bodyLimit ? splitText(slide.body, bodyLimit) : slide.body ? [slide.body] : [];
  const bulletChunks = budget.bullet ? slide.bullets.flatMap((item) => splitText(item, budget.bullet)) : [];
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
    const assets = (body.assets ?? []).slice(0, 10);
    const requestedPageCount = Math.max(4, Math.min(16, Number(body.profile.requestedPageCount) || 6));
    const facts = Array.isArray(body.profile.careers) ? body.profile.careers as Array<{ index?: number; category?: string }> : [];
    const requiredCareerSlides = Math.max(1, Math.ceil(facts.length / 5));
    const targetPageCount = Math.min(16, Math.max(requestedPageCount, 5 + requiredCareerSlides));
    const parts: Part[] = [{
      text: `당신은 Gamma 수준의 문화예술인 섭외·제안용 포트폴리오를 설계하는 시니어 아트디렉터입니다. 아래 사실과 이미지 후보만 사용해 편집 가능한 PPT의 최종 슬라이드 기획을 만드세요.\n\n커뮤니케이션 목표: 담당자가 예술인의 정체성, 무대 경쟁력, 검증된 활동, 섭외 방법을 짧은 시간에 이해하고 연락하게 만듭니다.\n\n중요: careers는 사용자가 직접 입력한 경력과 PDF에서 추출해 제외하지 않은 수상·공연·주요 활동·언론 사실을 합친 전체 근거 목록입니다. 일부만 골라 버리지 말고 모든 인덱스를 career 슬라이드에 한 번씩 배치하세요. extractedFacts와 PDF 페이지 텍스트도 소개·강점·제목을 구체화하는 근거로 사용하세요.\n\n구성 규칙:\n- 내용 누락을 막기 위해 요청 ${requestedPageCount}장보다 늘어난 정확히 ${targetPageCount}장의 slides를 반환합니다. 첫 장은 cover, 마지막 장은 contact입니다.\n- career 슬라이드는 최소 ${requiredCareerSlides}장이며 한 장당 최대 5개입니다. careers의 0~${Math.max(0, facts.length - 1)} 인덱스를 중복·누락 없이 careerIndexes에 모두 담습니다.\n- 수상·선정, 공연·활동, 방송·언론은 서로 의미가 드러나도록 career 페이지 제목과 흐름을 구분합니다.\n- 각 슬라이드는 하나의 주장만 전달합니다. 입력 내용을 페이지마다 복사하거나 장황하게 요약하지 않습니다.\n- 제목은 ABOUT, HISTORY 같은 분류명이 아니라 그 페이지가 전달할 구체적인 메시지로 씁니다.\n- 표지는 활동명과 짧은 태그라인만 두며 설명문을 넣지 않습니다.\n- 사진을 슬라이드 배경이나 full bleed로 사용하지 않습니다. 모든 이미지는 독립된 직사각형 프레임 안에 원본 비율로 삽입하고, 세로 사진·포스터도 잘리지 않게 합니다.\n- 이미지 후보는 실제 화면을 보고 서사를 강화할 때만 선택합니다.\n- 같은 이미지는 전체 PPT에서 한 번만 사용하고 imageRefs에는 제공된 정확한 asset id만 씁니다.\n- 경력은 원본 인덱스를 careerIndexes에 담고 사실을 만들거나 과장하지 않습니다.\n- 내부 기획 메모는 imagePurpose에만 쓰고 슬라이드 본문에는 노출하지 않습니다.\n\n슬라이드별 절대 분량 제한(한글·공백 포함):\n- cover: title 26자, body 55자, bullets 없음\n- about: title 34자, body 160자, bullets 최대 3개·각 34자\n- strengths: title 34자, body 없음, bullets 정확히 3개·각 42자\n- gallery: title 34자, body 70자, bullets 없음\n- career: title 34자, body 70자, bullets 없음, 근거 최대 5개\n- contact: title 30자, body 110자, bullets 최대 2개·각 36자\n- 분할 레이아웃에 이미지를 쓰는 about/contact 제목은 22자 이내로 더 짧게 씁니다.\n- 긴 본문이나 불릿은 절대 말줄임표로 자르지 않습니다. 분량이 많으면 같은 유형의 다음 슬라이드로 나눕니다.\n\n프로필 사실:\n${JSON.stringify(body.profile)}`,
    }];

    assets.forEach((asset) => {
      const match = asset.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!match) return;
      parts.push({ text: `이미지 후보 ID=${asset.id}, 종류=${asset.kind}${asset.pageNumber ? `, PDF ${asset.pageNumber}페이지` : ""}${asset.sourceTitle ? `, 출처=${asset.sourceTitle}` : ""}` });
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
    let careerSlides = plan.slides.filter((slide) => slide.type === "career");
    while (careerSlides.length < requiredCareerSlides) {
      const candidate = plan.slides.findLast((slide, index) => index > 1 && index < plan.slides.length - 1 && slide.type !== "career");
      const careerSlide = { type: "career" as const, eyebrow: "VERIFIED PROFILE", title: "문서로 확인된 주요 활동", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "timeline" as const };
      if (candidate) Object.assign(candidate, careerSlide);
      else plan.slides.splice(plan.slides.length - 1, 0, careerSlide);
      careerSlides = plan.slides.filter((slide) => slide.type === "career");
    }

    const categoryPriority: Record<string, number> = { award: 0, performance: 1, media: 2, career: 3 };
    const factIndexes = facts.map((fact, index) => ({ index, priority: categoryPriority[fact.category || "career"] ?? 3 })).sort((a, b) => a.priority - b.priority).map(({ index }) => index);
    careerSlides.forEach((slide, index) => {
      const indexes = factIndexes.slice(index * 5, index * 5 + 5);
      const categories = new Set(indexes.map((factIndex) => facts[factIndex]?.category));
      slide.careerIndexes = indexes;
      slide.eyebrow = categories.has("award") ? "AWARDS & RECOGNITION" : categories.has("performance") ? "SELECTED ACTIVITIES" : categories.has("media") ? "MEDIA & PRESS" : "SELECTED HISTORY";
      slide.title = categories.has("award") ? "수상과 선정으로 확인된 전문성" : categories.has("performance") ? "주요 무대와 활동의 기록" : categories.has("media") ? "방송과 언론이 기록한 활동" : "지속적으로 이어온 주요 경력";
      slide.body = "";
      slide.bullets = [];
      slide.imageRefs = [];
      slide.layout = "timeline";
    });

    const validIds = new Set(assets.map((asset) => asset.id));
    const usedIds = new Set<string>();
    plan.slides.forEach((slide) => {
      const budget = copyBudgets[slide.type];
      slide.imageRefs = slide.imageRefs.filter((id) => validIds.has(id) && !usedIds.has(id)).slice(0, 3);
      slide.imageRefs.forEach((id) => usedIds.add(id));
      slide.eyebrow = compactText(slide.eyebrow, 28).toUpperCase();
      slide.title = compactText(slide.title, budget.title);
      slide.body = budget.body ? slide.body.replace(/\s+/g, " ").trim() : "";
      slide.bullets = budget.bullets ? slide.bullets.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean) : [];
      slide.careerIndexes = [...new Set(slide.careerIndexes)].filter((index) => index < facts.length).slice(0, 5);
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
