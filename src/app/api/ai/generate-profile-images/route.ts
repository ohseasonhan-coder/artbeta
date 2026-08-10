import { GoogleGenAI, Modality, type Part } from "@google/genai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 180;

const requestSchema = z.object({
  artistName: z.string().trim().min(1).max(100),
  primaryField: z.string().trim().max(100).default(""),
  region: z.string().trim().max(100).default(""),
  affiliation: z.string().trim().max(160).default(""),
  activeSince: z.string().trim().max(40).default(""),
  identityHint: z.string().trim().max(400).default(""),
  officialUrl: z.string().trim().max(500).default(""),
  introduction: z.string().trim().max(1200).default(""),
  referenceImage: z.string().startsWith("data:image/").max(5_000_000),
  careers: z.array(z.object({
    year: z.string().max(40).default(""),
    title: z.string().max(240).default(""),
    organization: z.string().max(240).default(""),
  })).max(30).default([]),
  requests: z.array(z.object({
    id: z.string().min(1).max(80),
    purpose: z.string().min(1).max(300),
    aspectRatio: z.enum(["3:2", "16:9", "4:3", "2:3"]).default("3:2"),
    careerHint: z.string().max(500).default(""),
  })).min(1).max(3),
});

function describeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|quota|resource_exhausted/i.test(message)) return { code: "IMAGE_QUOTA_EXCEEDED", message: "Gemini 이미지 생성 한도를 초과했습니다. 한도 초기화 후 다시 시도해 주세요." };
  if (/401|403|api.?key|permission/i.test(message)) return { code: "IMAGE_AUTH_FAILED", message: "Gemini 이미지 생성 권한을 확인해 주세요. Vercel의 GEMINI_API_KEY와 GEMINI_IMAGE_MODEL 설정이 필요합니다." };
  if (/model|not found|unsupported/i.test(message)) return { code: "IMAGE_MODEL_UNAVAILABLE", message: "설정한 Gemini 이미지 모델을 사용할 수 없습니다. GEMINI_IMAGE_MODEL 값을 확인해 주세요." };
  return { code: "IMAGE_GENERATION_FAILED", message: "프로필용 보조 이미지를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요." };
}

async function optimizeImage(data: string, mimeType: string) {
  const image = await loadImage(Buffer.from(data, "base64"));
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const jpeg = canvas.toBuffer("image/jpeg", 86);
  return { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, originalMimeType: mimeType, width, height };
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Gemini API가 연결되지 않았습니다.", code: "AI_NOT_CONFIGURED" }, { status: 503 });
  }

  try {
    const body = requestSchema.parse(await request.json());
    const reference = body.referenceImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
    if (!reference) return NextResponse.json({ error: "대표사진 형식을 확인해 주세요." }, { status: 400 });

    const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const factualCareers = body.careers
      .filter((career) => career.title.trim() || career.organization.trim())
      .map((career) => [career.year, career.title, career.organization].filter(Boolean).join(" · "))
      .slice(0, 12);

    const generated: Array<{ id: string; dataUrl: string; originalMimeType: string; width: number; height: number; title: string; promptBasis: string; disclosure: string }> = [];
    for (const item of body.requests) {
      const basis: string = item.careerHint || factualCareers[generated.length % Math.max(1, factualCareers.length)] || `${body.primaryField} 활동`;
      const prompt = [
        "Create one premium editorial portfolio image for a Korean cultural artist presentation.",
        `Artist name: ${body.artistName}. Field: ${body.primaryField || "cultural arts"}. Region: ${body.region || "Korea"}. Affiliation: ${body.affiliation || "not provided"}. Active since: ${body.activeSince || "not provided"}.`,
        body.identityHint ? `Verified identity/career hint: ${body.identityHint}.` : "",
        `Requested scene: ${item.purpose}. Verified profile basis: ${basis}.`,
        body.introduction ? `Profile tone: ${body.introduction.slice(0, 420)}.` : "",
        "Use the attached user-provided portrait only as the identity and appearance reference. Preserve recognizable facial features, approximate age, hairstyle, and overall styling without beautifying into a different person.",
        "This is an explicitly labeled AI editorial reenactment inspired by verified profile facts, not documentary evidence of the real event. Do not invent awards, dates, collaborators, audience size, signage, logos, venue names, certificates, text, captions, watermarks, or brand marks inside the image.",
        "Natural Korean performance photography, believable stage lighting, realistic anatomy and hands, professional wardrobe appropriate to the field, coherent venue scale, no duplicated people, no collage, no border. Leave useful negative space for presentation typography.",
      ].filter(Boolean).join("\n");
      const parts: Part[] = [
        { text: prompt },
        { inlineData: { mimeType: reference[1], data: reference[2] } },
      ];
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          responseModalities: [Modality.IMAGE],
          imageConfig: { aspectRatio: item.aspectRatio, imageSize: "1K" },
        },
      });
      const imagePart = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
      if (!imagePart?.data) continue;
      const optimized = await optimizeImage(imagePart.data, imagePart.mimeType || "image/png");
      generated.push({
        id: item.id,
        ...optimized,
        title: `AI 연출 이미지 · ${item.purpose}`,
        promptBasis: basis,
        disclosure: "실제 현장 사진이 아닌, 사용자 제공 대표사진과 확인된 경력을 바탕으로 만든 AI 연출 이미지",
      });
    }

    if (!generated.length) throw new Error("NO_IMAGE_OUTPUT");
    return NextResponse.json({ images: generated, provider: "Gemini", model });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "이미지 생성 요청 내용을 확인해 주세요.", code: "INVALID_IMAGE_REQUEST" }, { status: 400 });
    console.error("Profile image generation failed", error);
    const failure = describeFailure(error);
    return NextResponse.json({ error: failure.message, code: failure.code }, { status: 502 });
  }
}
