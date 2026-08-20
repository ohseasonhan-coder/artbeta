import { NextResponse } from "next/server";
import { GoogleGenAI, type Part } from "@google/genai";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ResponseInputContent } from "openai/resources/responses/responses";
import { z } from "zod";
import { ExtractedItem, PdfPageAsset } from "@/types/profile";

export const runtime = "nodejs";
export const maxDuration = 300;

const factSchema = z.object({
  category: z.enum(["career", "performance", "award", "media"]),
  date: z.string(),
  title: z.string(),
  organization: z.string(),
  location: z.string(),
  description: z.string(),
  pageNumber: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});

const visualRegionSchema = z.object({
  pageNumber: z.number().int().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0.05).max(1),
  height: z.number().min(0.05).max(1),
  kind: z.enum(["photo", "graphic"]),
  description: z.string(),
  confidence: z.number().min(0).max(1),
});

const extractionSchema = z.object({
  artistName: z.string(),
  artistType: z.enum(["개인", "단체", "알 수 없음"]),
  primaryField: z.string(),
  secondaryFields: z.array(z.string()),
  region: z.string(),
  members: z.array(z.string()),
  contacts: z.array(z.string()),
  socialLinks: z.array(z.string()),
  introduction: z.string(),
  tagline: z.string(),
  strengths: z.array(z.string()),
  equipment: z.array(z.string()),
  facts: z.array(factSchema),
  visualRegions: z.array(visualRegionSchema),
  reviewNotes: z.array(z.string()),
});

type PageInput = Pick<PdfPageAsset, "pageNumber" | "previewDataUrl" | "text" | "textSource">;
type Extraction = z.infer<typeof extractionSchema>;

function buildPrompt(pageText: string) {
  return `문화예술인 프로필 PDF를 정밀하게 구조화하세요. 다음 규칙을 반드시 지키세요.\n\n- 문서에 실제로 있는 사실만 추출하고 추측하지 않습니다. 모르면 빈 문자열/빈 배열로 둡니다.\n- 연혁, 주요 활동, 공연, 전시, 교육, 수상·선정, 방송·언론에 있는 날짜 항목은 짧아 보여도 빠짐없이 facts에 한 건씩 담습니다.\n- 날짜·행사명·기관명·장소를 합치거나 생략하지 말고 원문의 순서와 표현을 보존합니다.\n- facts.category를 career, performance, award, media 중 가장 가까운 것으로 분류합니다.\n- 각 사실의 근거 페이지를 알면 pageNumber에 기록하고, 모르면 0으로 둡니다.\n- 소개문과 태그라인은 원문 사실만 요약해 한국어로 작성합니다.\n- 이미지 페이지는 OCR 결과가 부정확할 수 있으므로 화면에 보이는 글자를 직접 교차 확인합니다.\n- visualRegions에는 PPT에 독립적으로 사용할 수 있는 사진, 작품 이미지, 포스터, 핵심 그래픽의 위치만 기록합니다. 좌상단 기준 x/y/width/height를 페이지 전체 대비 0~1 비율로 반환합니다.\n- 문단, 표, 연혁 글자, 로고만 있는 영역은 visualRegions에 넣지 않습니다. 페이지 전체 또는 페이지 면적의 80%가 넘는 영역은 금지하고 한 페이지당 최대 4개만 반환합니다.\n\nPDF 추출 원문:\n${pageText}`;
}

async function analyzeWithGemini(prompt: string, pages: PageInput[], pdfBase64?: string): Promise<Extraction> {
  const parts: Part[] = [{ text: prompt }];
  if (pdfBase64) parts.push({ inlineData: { mimeType: "application/pdf", data: pdfBase64 } });
  pages.forEach((page) => {
    const match = page.previewDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
    if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
  });
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(extractionSchema),
      temperature: 0.1,
      maxOutputTokens: 32768,
    },
  });
  return extractionSchema.parse(JSON.parse(response.text || "{}"));
}

async function analyzeWithOpenAI(prompt: string, pages: PageInput[]): Promise<Extraction> {
  const content: ResponseInputContent[] = [
    { type: "input_text", text: prompt },
    ...pages
      .filter((page) => page.previewDataUrl.startsWith("data:image/"))
      .map((page) => ({ type: "input_image" as const, image_url: page.previewDataUrl, detail: "high" as const })),
  ];
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.parse({
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
    store: false,
    input: [{ role: "user", content }],
    text: { format: zodTextFormat(extractionSchema, "artist_profile_extraction") },
  });
  if (!response.output_parsed) throw new Error("OpenAI가 구조화된 결과를 반환하지 않았습니다.");
  return response.output_parsed;
}

const makeItem = (
  type: ExtractedItem["type"],
  label: string,
  value: string,
  confidence = 0.9,
  pageNumber?: number,
): ExtractedItem => ({
  id: `${type}-${crypto.randomUUID()}`,
  type,
  label,
  value,
  confidence,
  pageNumber: pageNumber || undefined,
  status: confidence < 0.7 ? "needs_review" : "approved",
});

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "AI API 키가 설정되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    let text = "";
    let pages: PageInput[] = [];
    let pdfBase64: string | undefined;
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const formData = await request.formData();
      text = String(formData.get("text") ?? "");
      const file = formData.get("file");
      if (file instanceof File && file.type === "application/pdf") {
        if (file.size > 30 * 1024 * 1024) return NextResponse.json({ error: "PDF는 최대 30MB까지 분석할 수 있습니다." }, { status: 413 });
        pdfBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      }
    } else {
      const body = (await request.json()) as { text?: string; pages?: PageInput[] };
      text = body.text ?? "";
      pages = (body.pages ?? []).slice(0, 10);
    }
    if (!text.trim() && !pages.length && !pdfBase64) {
      return NextResponse.json({ error: "분석할 PDF 내용이 없습니다." }, { status: 400 });
    }

    const pageText = (text || pages.map((page) => `[${page.pageNumber}페이지]\n${page.text}`).join("\n\n")).slice(0, 180_000);
    const prompt = buildPrompt(pageText);
    let profile: Extraction;
    let provider: "gemini" | "openai";
    if (process.env.GEMINI_API_KEY) {
      try {
        profile = await analyzeWithGemini(prompt, pages, pdfBase64);
        provider = "gemini";
      } catch (geminiError) {
        console.error("Gemini extraction failed", geminiError);
        if (!process.env.OPENAI_API_KEY) throw geminiError;
        profile = await analyzeWithOpenAI(prompt, pages);
        provider = "openai";
      }
    } else {
      profile = await analyzeWithOpenAI(prompt, pages);
      provider = "openai";
    }

    const items: ExtractedItem[] = [];
    if (profile.artistName) items.push(makeItem("artist_name", "활동명", profile.artistName));
    if (profile.artistType !== "알 수 없음") items.push(makeItem("artist_type", "활동 형태", profile.artistType));
    if (profile.primaryField) items.push(makeItem("field", "주 활동 분야", [profile.primaryField, ...profile.secondaryFields].join(" · ")));
    if (profile.introduction) items.push(makeItem("introduction", "소개문", profile.introduction, 0.88));
    if (profile.tagline) items.push(makeItem("tagline", "한 줄 소개", profile.tagline, 0.86));
    if (profile.region) items.push(makeItem("region", "활동 지역", profile.region));
    profile.members.forEach((value) => items.push(makeItem("member", "구성원", value)));
    profile.contacts.forEach((value) => items.push(makeItem("contact", "연락처", value)));
    profile.socialLinks.forEach((value) => items.push(makeItem("social_link", "웹/SNS", value)));
    profile.strengths.forEach((value) => items.push(makeItem("strength", "강점", value, 0.84)));
    profile.equipment.forEach((value) => items.push(makeItem("equipment", "장비·구성", value, 0.84)));
    profile.facts.forEach((fact) => {
      const labels = { career: "연혁·경력", performance: "공연·활동", award: "수상·선정", media: "방송·언론" } as const;
      const value = [fact.date, fact.title, fact.organization, fact.location, fact.description].filter(Boolean).join(" · ");
      items.push(makeItem(fact.category, labels[fact.category], value, fact.confidence, fact.pageNumber));
    });

    const model = provider === "gemini" ? process.env.GEMINI_MODEL || "gemini-3.6-flash" : process.env.OPENAI_MODEL || "gpt-5.6-sol";
    return NextResponse.json({ profile, items, mode: "ai", provider, model });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "AI 정밀 분석을 완료하지 못했습니다. 기본 분석 결과는 계속 사용할 수 있습니다.", code: "AI_EXTRACTION_FAILED" }, { status: 502 });
  }
}
