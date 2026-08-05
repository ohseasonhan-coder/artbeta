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
      warnings: analysis.warnings,
      needsOcr: false,
    });
  } catch (error) {
    console.error(error);
    const errorName = error instanceof Error ? error.name : "UnknownError";
    if (errorName === "PasswordException") {
      return NextResponse.json({ error: "암호로 보호된 PDF입니다. 암호를 해제한 사본을 업로드해 주세요.", code: "PDF_PASSWORD_REQUIRED" }, { status: 422 });
    }
    if (errorName === "InvalidPDFException") {
      return NextResponse.json({ error: "PDF 구조를 읽지 못했습니다. 다른 이름으로 다시 저장하거나 인쇄 → PDF로 저장한 파일을 사용해 주세요.", code: "PDF_INVALID" }, { status: 422 });
    }
    return NextResponse.json({
      error: "PDF를 분석하지 못했습니다. 파일을 다시 저장해 업로드하거나 이미지 파일을 직접 추가해 주세요.",
      code: "PDF_ANALYSIS_FAILED",
    }, { status: 422 });
  }
}
