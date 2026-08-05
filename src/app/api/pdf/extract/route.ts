import { NextResponse } from "next/server";
import { inferItemsFromText } from "@/features/pdf-import/parsers/extract-items";
import { FILE_LIMITS } from "@/config/file-limits";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "PDF 파일이 필요합니다." }, { status: 400 });
    if (file.type !== "application/pdf") return NextResponse.json({ error: "PDF 형식만 업로드할 수 있습니다." }, { status: 415 });
    if (file.size > FILE_LIMITS.pdf) return NextResponse.json({ error: "PDF는 최대 30MB까지 업로드할 수 있습니다." }, { status: 413 });

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await file.arrayBuffer());
    const document = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    const text = pages.join("\n").trim();
    return NextResponse.json({ pageCount: document.numPages, text, items: inferItemsFromText(text), needsOcr: !text });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "PDF를 읽지 못했습니다. 이미지형 PDF라면 설문 방식으로 계속해 주세요." }, { status: 422 });
  }
}

