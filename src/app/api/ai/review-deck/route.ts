import { GoogleGenAI, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const revisionSchema = z.object({
  title: z.string(),
  body: z.string(),
  bullets: z.array(z.string()),
  layout: z.enum(["full_bleed", "split_left", "split_right", "editorial", "timeline", "gallery"]),
});

const slideReviewSchema = z.object({
  slideIndex: z.number().int().min(0),
  score: z.number().int().min(0).max(100),
  verdict: z.enum(["pass", "revise"]),
  issues: z.array(z.string()).max(5),
  rationale: z.string(),
  revision: revisionSchema.optional(),
});

const reviewSchema = z.object({
  overallScore: z.number().int().min(0).max(100),
  deckIssues: z.array(z.string()).max(8),
  slides: z.array(slideReviewSchema),
});

interface FrameInput {
  index: number;
  type: string;
  image: string;
}
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

function failureResponse(error: unknown) {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (status === 429 || message.includes("quota") || message.includes("resource_exhausted")) return { code: "VISUAL_REVIEW_QUOTA", status: 503, error: "Gemini 시각 검수 한도에 도달했습니다. 기존 안전검사 결과로 계속 진행합니다." };
  if (error instanceof SyntaxError || error instanceof z.ZodError) return { code: "VISUAL_REVIEW_INVALID", status: 502, error: "Gemini 시각 검수 응답을 해석하지 못했습니다." };
  return { code: "VISUAL_REVIEW_FAILED", status: 502, error: "Gemini 시각 검수를 완료하지 못했습니다. 기존 안전검사 결과로 계속 진행합니다." };
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return NextResponse.json({ error: "Gemini가 연결되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  try {
    const body = await request.json() as { profile?: Record<string, unknown>; plan?: Record<string, unknown>; frames?: FrameInput[]; iteration?: number };
    const frames = (body.frames ?? []).filter((frame) => /^data:image\/jpeg;base64,/i.test(frame.image)).slice(0, 16);
    if (!frames.length || !body.plan) return NextResponse.json({ error: "검수할 슬라이드 프레임이 없습니다.", code: "VISUAL_REVIEW_EMPTY" }, { status: 400 });
    const parts: Part[] = [{ text: `당신은 문화예술인 섭외 제안서의 아트디렉터이자 최종 출고 검사자입니다.
첨부된 이미지는 실제 PPT 좌표·사진·글자 배치를 16:9로 재현한 검수 프레임입니다. JSON 설명보다 첨부 화면을 우선 평가하세요.

평가 목표:
- 행사·공공기관·기업 담당자가 10초 안에 핵심을 이해하고 섭외 검토를 시작할 수 있어야 합니다.
- 각 페이지는 한 가지 주장만 전달하고, 실제 경력·조건·프로그램과 연결되어야 합니다.

페이지별 평가 항목:
1. 글자 잘림, 겹침, 프레임 이탈, 지나치게 작은 글씨
2. 한국어 어절·고유명사·기관명·공연명의 어색한 줄바꿈
3. 사진 크롭, 해상도 체감, 인물 절단, 사진과 페이지 메시지의 적합성
4. 여백, 정렬, 시선 흐름, 제목과 본문의 위계
5. 같은 구성·문장·사진이 반복되어 템플릿처럼 보이는지
6. 담당자에게 필요한 가치·근거·선택지·문의 행동이 명확한지

수정 절대 규칙:
- profile과 plan에 없는 사실, 숫자, 경력, 수상, 기관, 공연명을 만들지 마세요.
- imageRefs와 careerIndexes는 수정할 수 없습니다. revision에는 화면 문구와 layout만 제안하세요.
- title은 최대 32자, body는 최대 105자, bullet은 항목당 최대 48자로 작성하세요.
- 내부 제작 문구, 원문 페이지, 2p 같은 표기, PHOTO BRIEF, 사실 확인 필요 문구를 쓰지 마세요.
- 문제를 숨기기 위해 내용을 무조건 길게 만들거나 추상적인 홍보 문구를 추가하지 마세요.
- 90점 이상은 실제 전달 가능한 페이지에만 부여하세요. 90점 미만이면 verdict=revise와 revision을 제공하세요.

검수 반복: ${Number(body.iteration || 1)}회차
프로필 근거: ${JSON.stringify(body.profile ?? {})}
현재 기획: ${JSON.stringify(body.plan)}` }];
    frames.forEach((frame) => {
      parts.push({ text: `슬라이드 ${frame.index + 1} · 유형 ${frame.type}` });
      parts.push({ inlineData: { mimeType: "image/jpeg", data: frame.image.replace(/^data:image\/jpeg;base64,/i, "") } });
    });
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await withGeminiAvailabilityRetry(() => ai.models.generateContent({
      model: process.env.GEMINI_VISUAL_REVIEW_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(reviewSchema), temperature: 0.15, maxOutputTokens: 12288 },
    }));
    const review = reviewSchema.parse(JSON.parse(result.text || "{}"));
    return NextResponse.json({ ...review, provider: "Gemini", model: process.env.GEMINI_VISUAL_REVIEW_MODEL || process.env.GEMINI_MODEL || "gemini-3.6-flash", reviewVersion: "visual-director-v1" });
  } catch (error) {
    const failure = failureResponse(error);
    return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
  }
}
