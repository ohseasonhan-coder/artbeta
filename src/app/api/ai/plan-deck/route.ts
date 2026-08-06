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

interface AssetInput {
  id: string;
  kind: "representative" | "performance" | "pdf_page";
  pageNumber?: number;
  dataUrl: string;
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

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Gemini가 연결되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as { profile: Record<string, unknown> & { requestedPageCount?: number }; assets: AssetInput[] };
    const assets = (body.assets ?? []).slice(0, 10);
    const requestedPageCount = Math.max(4, Math.min(10, Number(body.profile.requestedPageCount) || 6));
    const parts: Part[] = [{
      text: `당신은 Gamma 수준의 문화예술인 섭외·제안용 포트폴리오를 설계하는 시니어 아트디렉터입니다. 아래 사실과 이미지 후보만 사용해 편집 가능한 PPT의 최종 슬라이드 기획을 만드세요.\n\n커뮤니케이션 목표: 담당자가 예술인의 정체성, 무대 경쟁력, 검증된 활동, 섭외 방법을 짧은 시간에 이해하고 연락하게 만듭니다.\n\n구성 규칙:\n- 반드시 정확히 ${requestedPageCount}장의 slides를 반환합니다. 첫 장은 cover, 마지막 장은 contact이며 career를 최소 1장 포함합니다.\n- 경력이 9개를 넘으면 career 슬라이드를 여러 장으로 나누고 careerIndexes가 겹치지 않게 합니다.\n- 각 슬라이드는 하나의 주장만 전달합니다. 입력 내용을 페이지마다 복사하거나 장황하게 요약하지 않습니다.\n- 제목은 ABOUT, HISTORY 같은 분류명이 아니라 그 페이지가 전달할 구체적인 메시지로 씁니다.\n- 표지는 활동명과 짧은 태그라인만 두며 설명문을 넣지 않습니다.\n- 이미지 후보는 실제 화면을 보고 서사를 강화할 때만 선택합니다. 대표사진은 정체성, 공연사진은 무대 규모·관객 반응·장르, pdf_page는 포스터·인증·작품 배열의 증거로 사용합니다.\n- 같은 이미지는 전체 PPT에서 한 번만 사용하고 imageRefs에는 제공된 정확한 asset id만 씁니다.\n- 경력은 원본 인덱스를 careerIndexes에 담고 사실을 만들거나 과장하지 않습니다.\n- 내부 기획 메모는 imagePurpose에만 쓰고 슬라이드 본문에는 노출하지 않습니다.\n\n슬라이드별 절대 분량 제한(한글·공백 포함):\n- cover: title 26자, body 55자, bullets 없음\n- about: title 34자, body 160자, bullets 최대 3개·각 34자\n- strengths: title 34자, body 없음, bullets 정확히 3개·각 42자\n- gallery: title 34자, body 70자, bullets 없음\n- career: title 34자, body 70자, bullets 없음, 경력 최대 9개\n- contact: title 30자, body 110자, bullets 최대 2개·각 36자\n- 분할 레이아웃에 이미지를 쓰는 about/contact 제목은 22자 이내로 더 짧게 씁니다.\n- 공간보다 내용이 많으면 글자를 작게 만들지 말고 핵심 사실만 남겨 줄입니다.\n\n프로필 사실:\n${JSON.stringify(body.profile)}`,
    }];

    assets.forEach((asset) => {
      const match = asset.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      if (!match) return;
      parts.push({ text: `이미지 후보 ID=${asset.id}, 종류=${asset.kind}${asset.pageNumber ? `, PDF ${asset.pageNumber}페이지` : ""}` });
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
    if (plan.slides.length !== requestedPageCount) throw new Error("Gemini가 요청한 페이지 수를 지키지 않았습니다.");
    if (plan.slides[0]?.type !== "cover" || plan.slides.at(-1)?.type !== "contact" || !plan.slides.some((slide) => slide.type === "career")) {
      throw new Error("Gemini가 필수 슬라이드 구조를 지키지 않았습니다.");
    }
    const validIds = new Set(assets.map((asset) => asset.id));
    const usedIds = new Set<string>();
    plan.slides.forEach((slide) => {
      const budget = copyBudgets[slide.type];
      slide.imageRefs = slide.imageRefs.filter((id) => validIds.has(id) && !usedIds.has(id)).slice(0, 3);
      slide.imageRefs.forEach((id) => usedIds.add(id));
      const bodyBudget = slide.imageRefs.length && slide.type === "about" ? 110 : slide.imageRefs.length && slide.type === "contact" ? 85 : budget.body;
      slide.eyebrow = compactText(slide.eyebrow, 28).toUpperCase();
      slide.title = compactText(slide.title, budget.title);
      slide.body = compactText(slide.body, bodyBudget);
      slide.bullets = slide.bullets.slice(0, budget.bullets).map((item) => compactText(item, budget.bullet));
      slide.careerIndexes = [...new Set(slide.careerIndexes)].slice(0, 9);
    });
    return NextResponse.json({ plan, mode: "ai", provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash" });
  } catch (error) {
    console.error("Gemini deck planning failed", error);
    return NextResponse.json({ error: "Gemini가 PPT 구성을 완료하지 못했습니다.", code: "DECK_PLANNING_FAILED" }, { status: 502 });
  }
}
