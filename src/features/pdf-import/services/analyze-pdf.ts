import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { PdfExtractedVisual, PdfPageAsset } from "@/types/profile";

const MIN_EMBEDDED_TEXT_LENGTH = 40;
const PRIMARY_RENDER_SIZE = 1400;
const FALLBACK_RENDER_SIZE = 900;

interface PdfImageObject { width: number; height: number; data?: Uint8Array | Uint8ClampedArray }

function rgbaPixels(image: PdfImageObject) {
  if (!image.data) return null;
  const pixels = image.width * image.height;
  if (image.data.length === pixels * 4) return new Uint8ClampedArray(image.data);
  if (image.data.length === pixels * 3) {
    const rgba = new Uint8ClampedArray(pixels * 4);
    for (let source = 0, target = 0; source < image.data.length; source += 3, target += 4) {
      rgba[target] = image.data[source]; rgba[target + 1] = image.data[source + 1]; rgba[target + 2] = image.data[source + 2]; rgba[target + 3] = 255;
    }
    return rgba;
  }
  return null;
}

function visualKind(data: Uint8ClampedArray): PdfExtractedVisual["kind"] {
  const colors = new Set<string>();
  const stride = Math.max(4, Math.floor(data.length / 900 / 4) * 4);
  for (let index = 0; index < data.length; index += stride) colors.add(`${data[index] >> 4}${data[index + 1] >> 4}${data[index + 2] >> 4}`);
  return colors.size > 70 ? "photo" : "graphic";
}

async function extractPageVisuals(
  page: Awaited<ReturnType<Awaited<ReturnType<(typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["getDocument"]>["promise"]>["getPage"]>>,
  ops: (typeof import("pdfjs-dist/legacy/build/pdf.mjs"))["OPS"],
  pageNumber: number,
) {
  const viewport = page.getViewport({ scale: 1 });
  const pageRatio = viewport.width / viewport.height;
  const operatorList = await page.getOperatorList();
  const objectStore = (page as unknown as { objs: { get: (id: string, callback: (image: PdfImageObject) => void) => void } }).objs;
  const candidates: PdfImageObject[] = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (operation === ops.paintImageXObject && typeof args?.[0] === "string") {
      const image = await new Promise<PdfImageObject | null>((resolve) => objectStore.get(args[0], (value) => resolve(value || null)));
      if (image) candidates.push(image);
    } else if (operation === ops.paintInlineImageXObject && args?.[0]) candidates.push(args[0] as PdfImageObject);
  }
  const signatures = new Set<string>();
  const visuals: PdfExtractedVisual[] = [];
  for (const image of candidates.sort((a, b) => b.width * b.height - a.width * a.height)) {
    if (image.width < 180 || image.height < 150 || image.width * image.height < 80_000) continue;
    const ratio = image.width / image.height;
    const looksLikeFullPageScan = Math.abs(Math.log(ratio / pageRatio)) < 0.07 && Math.max(image.width, image.height) > Math.max(viewport.width, viewport.height) * 1.6;
    if (looksLikeFullPageScan) continue;
    const pixels = rgbaPixels(image); if (!pixels) continue;
    const signature = `${image.width}x${image.height}:${Array.from(pixels.slice(0, 48)).join("-")}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const outputWidth = Math.max(1, Math.round(image.width * scale)); const outputHeight = Math.max(1, Math.round(image.height * scale));
    const source = createCanvas(image.width, image.height); source.getContext("2d").putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
    const canvas = createCanvas(outputWidth, outputHeight); canvas.getContext("2d").drawImage(source, 0, 0, outputWidth, outputHeight);
    visuals.push({ id: `p${pageNumber}-visual-${visuals.length + 1}`, dataUrl: `data:image/jpeg;base64,${canvas.toBuffer("image/jpeg", 88).toString("base64")}`, width: outputWidth, height: outputHeight, kind: visualKind(pixels), selected: true });
    if (visuals.length >= 4) break;
  }
  return visuals;
}

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
    extractedVisuals: PdfExtractedVisual[];
  }> = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    let embeddedText = "";
    let page = await document.getPage(pageNumber);
    let extractedVisuals: PdfExtractedVisual[] = [];
    try { extractedVisuals = await extractPageVisuals(page, pdfjs.OPS, pageNumber); } catch { warnings.push(`${pageNumber}페이지의 개별 이미지 분리는 건너뛰었습니다.`); }
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
    renderedPages.push({ pageNumber, embeddedText, canOcr, extractedVisuals, ...rendered });
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
      extractedVisuals: page.extractedVisuals,
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
