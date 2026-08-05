import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { PdfPageAsset } from "@/types/profile";

const MIN_EMBEDDED_TEXT_LENGTH = 40;
const PRIMARY_RENDER_SIZE = 1400;
const FALLBACK_RENDER_SIZE = 900;

function installPdfGraphicsGlobals() {
  const target = globalThis as unknown as Record<string, unknown>;
  target.DOMMatrix ??= DOMMatrix;
  target.ImageData ??= ImageData;
  target.Path2D ??= Path2D;
}

function createPlaceholder(pageNumber: number) {
  const canvas = createCanvas(900, 1200);
  const context = canvas.getContext("2d");
  context.fillStyle = "#eef1ef";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1f6049";
  context.font = "bold 40px Arial";
  context.textAlign = "center";
  context.fillText(`PAGE ${pageNumber}`, canvas.width / 2, canvas.height / 2 - 20);
  context.fillStyle = "#68736d";
  context.font = "24px Arial";
  context.fillText("Preview unavailable", canvas.width / 2, canvas.height / 2 + 30);
  const image = canvas.toBuffer("image/jpeg", 82);
  return { image, previewDataUrl: `data:image/jpeg;base64,${image.toString("base64")}` };
}

async function renderPage(
  page: Awaited<ReturnType<Awaited<ReturnType<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]>["promise"]>["getPage"]>>,
  maxDimension: number,
) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(1.8, maxDimension / Math.max(baseViewport.width, baseViewport.height));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const renderContext = {
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
    viewport,
  };
  await page.render(renderContext as unknown as Parameters<typeof page.render>[0]).promise;
  const image = canvas.toBuffer("image/jpeg", 82);
  return { image, previewDataUrl: `data:image/jpeg;base64,${image.toString("base64")}` };
}

export interface PdfAnalysisResult {
  pages: PdfPageAsset[];
  combinedText: string;
  ocrPageCount: number;
  warnings: string[];
}

export async function analyzePdf(data: Uint8Array): Promise<PdfAnalysisResult> {
  installPdfGraphicsGlobals();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const document = await loadingTask.promise;
  const warnings: string[] = [];
  const renderedPages: Array<{
    pageNumber: number;
    previewDataUrl: string;
    embeddedText: string;
    image: Buffer;
    canOcr: boolean;
  }> = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    let embeddedText = "";
    let page = await document.getPage(pageNumber);
    try {
      const content = await page.getTextContent();
      embeddedText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
    } catch {
      warnings.push(`${pageNumber}페이지의 텍스트 레이어를 읽지 못해 이미지 분석을 시도했습니다.`);
    }

    let rendered: ReturnType<typeof createPlaceholder>;
    let canOcr = true;
    try {
      rendered = await renderPage(page, PRIMARY_RENDER_SIZE);
    } catch {
      try {
        page.cleanup();
        page = await document.getPage(pageNumber);
        rendered = await renderPage(page, FALLBACK_RENDER_SIZE);
        warnings.push(`${pageNumber}페이지는 호환 모드로 이미지를 변환했습니다.`);
      } catch {
        rendered = createPlaceholder(pageNumber);
        canOcr = false;
        warnings.push(`${pageNumber}페이지의 미리보기를 만들지 못했습니다. 추출된 텍스트만 사용합니다.`);
      }
    }
    renderedPages.push({ pageNumber, embeddedText, canOcr, ...rendered });
    page.cleanup();
  }

  const sparsePages = renderedPages.filter((page) => page.canOcr && page.embeddedText.length < MIN_EMBEDDED_TEXT_LENGTH);
  const ocrResults = new Map<number, { text: string; confidence: number }>();

  if (sparsePages.length) {
    let worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null;
    try {
      const { createWorker } = await import("tesseract.js");
      const cachePath = join(tmpdir(), "artfolio-tesseract-cache");
      await mkdir(cachePath, { recursive: true });
      worker = await createWorker(["kor", "eng"], undefined, { cachePath });
      for (const page of sparsePages) {
        try {
          const result = await worker.recognize(page.image);
          ocrResults.set(page.pageNumber, {
            text: result.data.text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
            confidence: Math.max(0, Math.min(1, result.data.confidence / 100)),
          });
        } catch {
          warnings.push(`${page.pageNumber}페이지의 OCR을 완료하지 못했습니다. 페이지 이미지는 그대로 사용할 수 있습니다.`);
        }
      }
    } catch {
      warnings.push("OCR 엔진에 연결하지 못했습니다. 페이지 이미지는 보존했으며 텍스트를 직접 입력할 수 있습니다.");
    } finally {
      if (worker) await worker.terminate().catch(() => undefined);
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

  await loadingTask.destroy();
  return {
    pages,
    combinedText: pages.map((page) => page.text).filter(Boolean).join("\n"),
    ocrPageCount: pages.filter((page) => page.textSource === "ocr").length,
    warnings,
  };
}
