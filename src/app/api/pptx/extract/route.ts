import { GoogleGenAI, type Part } from "@google/genai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import JSZip, { type JSZipObject } from "jszip";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 300;

const selectionSchema = z.object({
  selections: z.array(z.object({
    index: z.number().int().min(0),
    role: z.enum(["representative", "activity", "poster", "history"]),
    relevanceScore: z.number().min(0).max(1),
    qualityScore: z.number().min(0).max(1),
    reason: z.string(),
  })).max(8),
});

interface ImageCandidate {
  index: number;
  fileName: string;
  dataUrl: string;
  width: number;
  height: number;
  slideNumbers: number[];
}

type SelectedImage = ImageCandidate & { role: "representative" | "activity" | "poster" | "history"; relevanceScore: number; qualityScore: number; reason: string };

const mimeByExtension: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function decodeXml(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function optimizeImage(buffer: Buffer, mimeType: string) {
  const image = await loadImage(buffer);
  if (image.width < 320 || image.height < 200) return null;
  const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const optimized = mimeType === "image/png" && buffer.length < 1_500_000 ? buffer : canvas.toBuffer("image/jpeg", 84);
  return { dataUrl: `data:${optimized === buffer ? mimeType : "image/jpeg"};base64,${optimized.toString("base64")}`, width: image.width, height: image.height };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".pptx")) return NextResponse.json({ error: "PPTX 파일을 선택해 주세요." }, { status: 415 });
    if (file.size > 40 * 1024 * 1024) return NextResponse.json({ error: "PPTX는 최대 40MB까지 분석할 수 있습니다." }, { status: 413 });

    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    if (Object.keys(zip.files).length > 600) return NextResponse.json({ error: "PPTX 내부 파일이 너무 많아 안전하게 분석할 수 없습니다." }, { status: 413 });
    const slidePaths = Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1]) - Number(b.match(/slide(\d+)/i)?.[1]));
    if (!slidePaths.length) return NextResponse.json({ error: "슬라이드를 찾지 못했습니다. PPTX 형식으로 다시 저장해 주세요." }, { status: 422 });

    const slideTexts: string[] = [];
    const mediaSlides = new Map<string, number[]>();
    for (const slidePath of slidePaths) {
      const slideNumber = Number(slidePath.match(/slide(\d+)/i)?.[1]) || slideTexts.length + 1;
      const xml = await zip.file(slidePath)?.async("string") || "";
      const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1])).filter(Boolean).join(" · ");
      slideTexts.push(`[${slideNumber}슬라이드]\n${text}`);
      const relsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`;
      const rels = await zip.file(relsPath)?.async("string") || "";
      for (const match of rels.matchAll(/Target="\.\.\/media\/([^"?#]+)"/g)) {
        const current = mediaSlides.get(match[1]) ?? [];
        if (!current.includes(slideNumber)) mediaSlides.set(match[1], [...current, slideNumber]);
      }
    }

    const seenHashes = new Set<string>();
    const rawCandidates = await Promise.all(Object.keys(zip.files).filter((path) => /^ppt\/media\//i.test(path)).slice(0, 80).map(async (path) => {
      try {
        const extension = path.split(".").pop()?.toLowerCase() || "";
        const mimeType = mimeByExtension[extension];
        if (!mimeType) return null;
        const entry = zip.file(path)! as JSZipObject & { _data?: { uncompressedSize?: number } };
        if ((entry._data?.uncompressedSize ?? 0) > 8 * 1024 * 1024) return null;
        const buffer = Buffer.from(await entry.async("uint8array"));
        if (buffer.length > 8 * 1024 * 1024) return null;
        const hash = createHash("sha256").update(buffer).digest("hex");
        if (seenHashes.has(hash)) return null;
        seenHashes.add(hash);
        const optimized = await optimizeImage(buffer, mimeType);
        if (!optimized) return null;
        const fileName = path.split("/").pop() || path;
        return { index: 0, fileName, ...optimized, slideNumbers: mediaSlides.get(fileName) ?? [] } satisfies ImageCandidate;
      } catch { return null; }
    }));
    const candidates = rawCandidates.filter((value): value is ImageCandidate => Boolean(value)).sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 20).map((candidate, index) => ({ ...candidate, index }));
    const text = slideTexts.join("\n\n").slice(0, 180_000);

    let selected: SelectedImage[] = candidates.slice(0, 8).map((candidate, index) => {
      const context = candidate.slideNumbers.map((slideNumber) => slideTexts[slideNumber - 1] || "").join(" ");
      const role = /연혁|수상|보도|기사|award|history/i.test(context) ? "history" as const
        : /포스터|공연일시|행사일시|poster|concert/i.test(context) ? "poster" as const
        : index === 0 || candidate.width / Math.max(1, candidate.height) < 0.9 ? "representative" as const
        : "activity" as const;
      return { ...candidate, role, relevanceScore: 0.7, qualityScore: 0.7, reason: "크기·비율·슬라이드 문맥으로 자동 분류" };
    });
    let mode: "ai" | "size_fallback" = "size_fallback";
    if (process.env.GEMINI_API_KEY && candidates.length) {
      try {
        const parts: Part[] = [{ text: `문화예술인 기존 PPTX에서 새 프로필에 사용할 이미지를 고르고 역할을 분류하세요. 아래 슬라이드 텍스트를 근거로 2~8장만 선택합니다. representative=얼굴·인물·단체가 주제인 대표사진, activity=공연·전시·연주·창작·관객 반응 등 실제 활동 장면, poster=행사 포스터·홍보물·타이포그래피 중심 그래픽, history=연혁·수상·보도·인증 자료입니다. 로고, 아이콘, QR, 서명, 장식 배경, 색상 블록, 스크린샷 UI, 중복·유사 이미지, 작은 이미지, 문서 전체 캡처는 제외하세요. 포스터와 연혁 자료는 잘리지 않게 사용해야 하므로 activity로 잘못 분류하지 마세요. 첫 번째 representative 이미지는 표지로 사용할 만큼 주제가 선명해야 합니다. 인물 대표사진이 없으면 가장 강한 활동사진을 representative로 지정할 수 있습니다.\n\n${text}` }];
        candidates.forEach((candidate) => {
          const match = candidate.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
          parts.push({ text: `후보 index=${candidate.index}, 원본=${candidate.fileName}, 크기=${candidate.width}x${candidate.height}, 사용 슬라이드=${candidate.slideNumbers.join(",") || "알 수 없음"}` });
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        });
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({ model: process.env.GEMINI_MODEL || "gemini-3.6-flash", contents: [{ role: "user", parts }], config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(selectionSchema), temperature: 0.1 } });
        const selection = selectionSchema.parse(JSON.parse(response.text || "{}"));
        const used = new Set<number>();
        const aiSelected = selection.selections.filter((item) => item.relevanceScore >= 0.68 && item.qualityScore >= 0.6 && !used.has(item.index) && used.add(item.index)).map((item) => ({ ...candidates[item.index], ...item })).filter((item) => Boolean(item.dataUrl)).slice(0, 8);
        if (aiSelected.length) { selected = aiSelected; mode = "ai"; }
      } catch (error) { console.warn("PPTX image selection failed; using large-image fallback", error); }
    }

    return NextResponse.json({ text, slideCount: slidePaths.length, totalImageCount: candidates.length, selectedImageCount: selected.length, images: selected, mode });
  } catch (error) {
    console.error("PPTX extraction failed", error);
    return NextResponse.json({ error: "PPTX를 분석하지 못했습니다. 파일을 다시 저장해 업로드해 주세요." }, { status: 422 });
  }
}
