"use client";

import { PdfPageAsset } from "@/types/profile";

const MIN_EMBEDDED_TEXT_LENGTH = 40;

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
  const renderedPages: Array<{ pageNumber: number; previewDataUrl: string; embeddedText: string; image: Blob }> = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onProgress?.(35 + Math.round((pageNumber / document.numPages) * 25), `${pageNumber}페이지 이미지를 준비하는 중`);
    const page = await document.getPage(pageNumber);
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
    renderedPages.push({ pageNumber, embeddedText, image, previewDataUrl: canvas.toDataURL("image/jpeg", 0.82) });
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
