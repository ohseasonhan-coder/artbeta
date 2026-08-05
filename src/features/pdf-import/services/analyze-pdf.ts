import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { PdfPageAsset } from "@/types/profile";

const MIN_EMBEDDED_TEXT_LENGTH = 40;

function installPdfGraphicsGlobals() {
  const target = globalThis as unknown as Record<string, unknown>;
  target.DOMMatrix ??= DOMMatrix;
  target.ImageData ??= ImageData;
  target.Path2D ??= Path2D;
}

export interface PdfAnalysisResult {
  pages: PdfPageAsset[];
  combinedText: string;
  ocrPageCount: number;
}

export async function analyzePdf(data: Uint8Array): Promise<PdfAnalysisResult> {
  installPdfGraphicsGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const renderedPages: Array<{ pageNumber: number; previewDataUrl: string; embeddedText: string; image: Buffer }> = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const embeddedText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.8, 1400 / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    const renderContext = {
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    };
    await page.render(renderContext as unknown as Parameters<typeof page.render>[0]).promise;
    const image = canvas.toBuffer("image/jpeg", 82);
    renderedPages.push({ pageNumber, embeddedText, image, previewDataUrl: `data:image/jpeg;base64,${image.toString("base64")}` });
    page.cleanup();
  }

  const sparsePages = renderedPages.filter((page) => page.embeddedText.length < MIN_EMBEDDED_TEXT_LENGTH);
  let worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null;
  const ocrResults = new Map<number, { text: string; confidence: number }>();

  if (sparsePages.length) {
    const { createWorker } = await import("tesseract.js");
    try {
      worker = await createWorker(["kor", "eng"]);
      for (const page of sparsePages) {
        const result = await worker.recognize(page.image);
        ocrResults.set(page.pageNumber, {
          text: result.data.text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
          confidence: Math.max(0, Math.min(1, result.data.confidence / 100)),
        });
      }
    } finally {
      if (worker) await worker.terminate();
    }
  }

  const pages: PdfPageAsset[] = renderedPages.map((page) => {
    const ocr = ocrResults.get(page.pageNumber);
    const hasEmbeddedText = page.embeddedText.length >= MIN_EMBEDDED_TEXT_LENGTH;
    return {
      pageNumber: page.pageNumber,
      previewDataUrl: page.previewDataUrl,
      text: hasEmbeddedText ? page.embeddedText : ocr?.text ?? page.embeddedText,
      textSource: hasEmbeddedText ? "embedded" : ocr?.text ? "ocr" : "none",
      confidence: hasEmbeddedText ? 0.98 : ocr?.confidence ?? 0,
      selected: false,
    };
  });

  return {
    pages,
    combinedText: pages.map((page) => page.text).filter(Boolean).join("\n"),
    ocrPageCount: pages.filter((page) => page.textSource === "ocr").length,
  };
}
