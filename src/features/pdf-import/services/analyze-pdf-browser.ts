"use client";

import { PdfExtractedVisual, PdfPageAsset } from "@/types/profile";

const MIN_EMBEDDED_TEXT_LENGTH = 40;

interface PdfImageObject { width: number; height: number; data?: Uint8Array | Uint8ClampedArray; bitmap?: ImageBitmap }

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

function visualKind(context: CanvasRenderingContext2D, width: number, height: number): PdfExtractedVisual["kind"] {
  const sample = context.getImageData(0, 0, width, height).data;
  const colors = new Set<string>();
  const stride = Math.max(4, Math.floor(sample.length / 900 / 4) * 4);
  for (let index = 0; index < sample.length; index += stride) colors.add(`${sample[index] >> 4}${sample[index + 1] >> 4}${sample[index + 2] >> 4}`);
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
    const pixels = rgbaPixels(image);
    const signature = `${image.width}x${image.height}:${pixels ? Array.from(pixels.slice(0, 48)).join("-") : visuals.length}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const outputWidth = Math.max(1, Math.round(image.width * scale)); const outputHeight = Math.max(1, Math.round(image.height * scale));
    const canvas = window.document.createElement("canvas"); canvas.width = outputWidth; canvas.height = outputHeight;
    const context = canvas.getContext("2d", { alpha: false }); if (!context) continue;
    if (image.bitmap) context.drawImage(image.bitmap, 0, 0, outputWidth, outputHeight);
    else if (pixels) { const source = window.document.createElement("canvas"); source.width = image.width; source.height = image.height; source.getContext("2d")?.putImageData(new ImageData(pixels, image.width, image.height), 0, 0); context.drawImage(source, 0, 0, outputWidth, outputHeight); }
    else continue;
    visuals.push({ id: `p${pageNumber}-visual-${visuals.length + 1}`, dataUrl: canvas.toDataURL("image/jpeg", 0.88), width: outputWidth, height: outputHeight, kind: visualKind(context, outputWidth, outputHeight), selected: true });
    if (visuals.length >= 4) break;
  }
  return visuals;
}

export interface BrowserPdfAnalysisResult {
  pages: PdfPageAsset[];
  combinedText: string;
  ocrPageCount: number;
  warnings: string[];
}

export async function analyzePdfInBrowser(file: File, onProgress?: (progress: number, message: string) => void): Promise<BrowserPdfAnalysisResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document = await loadingTask.promise;
  const warnings: string[] = [];
  const renderedPages: Array<{ pageNumber: number; previewDataUrl: string; embeddedText: string; image: Blob; extractedVisuals: PdfExtractedVisual[] }> = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress?.(35 + Math.round((pageNumber / document.numPages) * 25), `${pageNumber}페이지 이미지를 준비하는 중`);
    const page = await document.getPage(pageNumber);
    let extractedVisuals: PdfExtractedVisual[] = [];
    try { extractedVisuals = await extractPageVisuals(page, pdfjs.OPS, pageNumber); } catch { warnings.push(`${pageNumber}페이지의 개별 이미지 분리는 건너뛰었습니다.`); }
    let embeddedText = "";
    try {
      const content = await page.getTextContent();
      embeddedText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ").trim();
    } catch {
      warnings.push(`${pageNumber}페이지의 텍스트 레이어를 읽지 못해 OCR을 사용했습니다.`);
    }
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.8, 1400 / Math.max(baseViewport.width, baseViewport.height));
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("브라우저에서 PDF 캔버스를 만들지 못했습니다.");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("페이지 이미지를 만들지 못했습니다.")), "image/jpeg", 0.82));
    renderedPages.push({ pageNumber, embeddedText, image, extractedVisuals, previewDataUrl: canvas.toDataURL("image/jpeg", 0.82) });
    page.cleanup();
  }

  const sparsePages = renderedPages.filter((page) => page.embeddedText.length < MIN_EMBEDDED_TEXT_LENGTH);
  const ocrResults = new Map<number, { text: string; confidence: number }>();
  if (sparsePages.length) {
    let worker: Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>> | null = null;
    try {
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker(["kor", "eng"]);
      for (let index = 0; index < sparsePages.length; index += 1) {
        const page = sparsePages[index];
        onProgress?.(65 + Math.round(((index + 1) / sparsePages.length) * 30), `${page.pageNumber}페이지 글자를 읽는 중`);
        try {
          const result = await worker.recognize(page.image);
          ocrResults.set(page.pageNumber, {
            text: result.data.text.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
            confidence: Math.max(0, Math.min(1, result.data.confidence / 100)),
          });
        } catch {
          warnings.push(`${page.pageNumber}페이지 OCR에 실패했지만 이미지는 보존했습니다.`);
        }
      }
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
  onProgress?.(100, "분석 완료");
  return {
    pages,
    combinedText: pages.map((page) => page.text).filter(Boolean).join("\n"),
    ocrPageCount: pages.filter((page) => page.textSource === "ocr").length,
    warnings,
  };
}
