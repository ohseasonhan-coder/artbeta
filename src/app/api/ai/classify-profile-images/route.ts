import { GoogleGenAI, type Part } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 120;

const imageRoleSchema = z.enum(["portrait", "stage", "poster", "history", "other", "exclude"]);
const resultSchema = z.object({
  classifications: z.array(z.object({
    id: z.string(),
    role: imageRoleSchema,
    relevanceScore: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
    duplicateOf: z.string().nullable().default(null),
    reason: z.string(),
  })).max(16),
});

interface ImageInput {
  id: string;
  dataUrl: string;
  pageNumber?: number;
  pageText?: string;
  width?: number;
  height?: number;
  kind?: "photo" | "graphic";
}

function fallbackRole(image: ImageInput) {
  const text = image.pageText || "";
  if (image.kind === "graphic" && /연혁|수상|보도|기사|award|history/i.test(text)) return "history" as const;
  if (image.kind === "graphic" && /공연|전시|콘서트|포스터|일시|장소|poster/i.test(text)) return "poster" as const;
  if (image.kind === "graphic") return "other" as const;
  const ratio = (image.width || 1) / Math.max(1, image.height || 1);
  return ratio < 0.9 ? "portrait" as const : "stage" as const;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { artistName?: string; primaryField?: string; images?: ImageInput[] };
    const images = (body.images ?? []).filter((image) => image.id && image.dataUrl.startsWith("data:image/")).slice(0, 16);
    if (!images.length) return NextResponse.json({ classifications: [], mode: "empty" });

    if (!process.env.GEMINI_API_KEY) {
      return NextResponse.json({
        mode: "heuristic",
        classifications: images.map((image) => ({ id: image.id, role: fallbackRole(image), relevanceScore: 0.65, qualityScore: 0.65, duplicateOf: null, reason: "이미지 비율과 페이지 문맥으로 자동 분류" })),
      });
    }

    const parts: Part[] = [{
      text: `문화예술인 '${body.artistName || "이름 미상"}'의 기존 PDF·PPTX에서 분리한 이미지를 새 제안서용 자산으로 분류하세요. 분야는 '${body.primaryField || "미지정"}'입니다. 각 이미지를 정확히 하나의 역할로 분류합니다. portrait=얼굴·인물·단체가 주제인 대표사진, stage=공연·전시·연주·창작·관객 반응 등 실제 활동 장면, poster=행사 포스터·홍보물·타이포그래피 중심 그래픽, history=연혁·수상·보도·인증 자료, other=작품·장소 등 보조 자산, exclude=로고·아이콘·QR·서명·장식 배경·문서 전체 캡처·UI·중복·저화질·주제 불명 이미지입니다. 여러 사진을 이어 붙인 콜라주, 영상 썸네일 합성, 서로 다른 시점·의상·인물이 한 화면에 분할된 몽타주는 portrait나 stage로 분류하지 마세요. 다만 동일 아티스트의 실제 공연 이력 또는 포스터를 한 화면에 정리한 고해상도 증빙 자료이고 글자와 개별 이미지가 식별 가능하면 history 또는 poster로 허용하며, 표지·배경이 아닌 경력 증빙용으로만 사용합니다. 원본 위에 큰 제목만 얹힌 저화질 홍보 이미지는 exclude입니다. 단체사진은 페이지 문맥에서 해당 아티스트가 명시되고 얼굴과 활동 장면이 충분히 선명할 때만 portrait 또는 stage로 허용합니다. 전체 후보를 서로 비교해 같은 사진, 같은 장면의 재크롭·축소본, 사실상 동일한 포스터가 있으면 가장 선명한 한 장만 유지하고 나머지는 role=exclude로 지정하며 duplicateOf에 유지할 이미지 ID를 기록하세요. 중복이 아니면 duplicateOf=null입니다. 페이지 문맥과 이미지 자체를 함께 보세요. 포스터와 연혁 자료는 잘리지 않게 사용해야 하므로 사진으로 잘못 분류하지 마세요. relevanceScore는 해당 아티스트 제안서와의 직접 관련성, qualityScore는 해상도·구도·가독성을 평가합니다. 추측으로 인물 신원을 확정하지 말고 보이는 역할만 분류하세요.`,
    }];
    images.forEach((image) => {
      const match = image.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
      parts.push({ text: `이미지 ID=${image.id}, 페이지=${image.pageNumber || "미상"}, 크기=${image.width || 0}x${image.height || 0}, 기본유형=${image.kind || "미상"}, 페이지문맥=${(image.pageText || "").slice(0, 700)}` });
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(resultSchema), temperature: 0.1 },
    });
    const parsed = resultSchema.parse(JSON.parse(response.text || "{}"));
    const classified = new Map(parsed.classifications.map((item) => [item.id, item]));
    return NextResponse.json({
      mode: "ai",
      classifications: images.map((image) => classified.get(image.id) || ({ id: image.id, role: fallbackRole(image), relevanceScore: 0.6, qualityScore: 0.6, duplicateOf: null, reason: "AI 응답 누락으로 문맥 기반 분류" })),
    });
  } catch (error) {
    console.error("Profile image classification failed", error);
    return NextResponse.json({ error: "문서 이미지를 분류하지 못했습니다." }, { status: 502 });
  }
}
