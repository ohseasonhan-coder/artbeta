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

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Gemini가 연결되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const body = (await request.json()) as { profile: Record<string, unknown>; assets: AssetInput[] };
    const assets = (body.assets ?? []).slice(0, 10);
    const parts: Part[] = [{
      text: `당신은 문화예술인 섭외·제안용 포트폴리오를 설계하는 시니어 아트디렉터입니다. 아래 사실과 이미지 후보만 사용해 편집 가능한 PPT의 슬라이드 기획을 만드세요.\n\n목표: 담당자가 예술인의 정체성, 무대 경쟁력, 검증된 활동, 섭외 방법을 빠르게 이해하고 연락하게 만듭니다.\n\n필수 규칙:\n- 각 슬라이드는 하나의 주장과 역할만 가집니다. 단순 정보 나열이나 반복 문구를 피합니다.\n- 제목은 ABOUT, HISTORY 같은 분류명이 아니라 그 페이지가 전달할 구체적인 메시지로 씁니다.\n- 이미지 후보는 실제 화면을 보고 서사를 강화하는 경우에만 선택합니다. 이유 없이 장식용으로 넣지 않습니다.\n- 대표사진은 인물·팀의 정체성을 보여줄 때, 공연사진은 무대 규모·관객 반응·장르를 증명할 때 사용합니다.\n- pdf_page는 포스터·인증·작품 배열 등 페이지 전체가 증거로 가치 있을 때만 사용합니다.\n- 같은 이미지는 한 번만 사용하고, imageRefs에는 제공된 정확한 asset id만 씁니다.\n- 경력은 원본 인덱스를 careerIndexes에 담고, 사실을 만들거나 과장하지 않습니다.\n- 첫 장은 최소한의 표지, 마지막 장은 구체적인 연락 행동으로 마칩니다.\n- 요청 페이지 수에 가깝게 4~10장으로 구성하고 이미지가 부족하면 타이포그래피 중심 레이아웃을 선택합니다.\n- 보이는 문구는 한국어로 자연스럽고 구체적으로 작성합니다. 내부 기획 메모는 imagePurpose에만 둡니다.\n\n프로필 사실:\n${JSON.stringify(body.profile)}`,
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
    if (plan.slides.length < 4 || plan.slides.length > 10) throw new Error("슬라이드 수가 허용 범위를 벗어났습니다.");
    const validIds = new Set(assets.map((asset) => asset.id));
    plan.slides.forEach((slide) => {
      slide.bullets = slide.bullets.slice(0, 5);
      slide.imageRefs = slide.imageRefs.filter((id) => validIds.has(id)).slice(0, 3);
      slide.careerIndexes = slide.careerIndexes.slice(0, 10);
    });
    return NextResponse.json({ plan, mode: "ai", provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash" });
  } catch (error) {
    console.error("Gemini deck planning failed", error);
    return NextResponse.json({ error: "Gemini가 PPT 구성을 완료하지 못했습니다.", code: "DECK_PLANNING_FAILED" }, { status: 502 });
  }
}
