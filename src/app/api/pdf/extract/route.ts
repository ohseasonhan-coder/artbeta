import { NextResponse } from "next/server";
import { inferItemsFromText } from "@/features/pdf-import/parsers/extract-items";
import { analyzePdf } from "@/features/pdf-import/services/analyze-pdf";
import { FILE_LIMITS } from "@/config/file-limits";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "PDF 파일이 필요합니다." }, { status: 400 });
    if (file.type !== "application/pdf") return NextResponse.json({ error: "PDF 형식만 업로드할 수 있습니다." }, { status: 415 });
    if (file.size > FILE_LIMITS.pdf) return NextResponse.json({ error: "PDF는 최대 30MB까지 업로드할 수 있습니다." }, { status: 413 });

    const analysis = await analyzePdf(new Uint8Array(await file.arrayBuffer()));
    return NextResponse.json({
      pageCount: analysis.pages.length,
      text: analysis.combinedText,
      items: inferItemsFromText(analysis.combinedText),
      pages: analysis.pages,
      ocrPageCount: analysis.ocrPageCount,
      needsOcr: false,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "PDF 분석에 실패했습니다. 파일이 손상되었거나 암호화되어 있는지 확인해 주세요." }, { status: 422 });
  }
}
