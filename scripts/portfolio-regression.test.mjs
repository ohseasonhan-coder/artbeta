import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createCanvas } from "@napi-rs/canvas";

async function importTypescript(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { careerLayout } = await importTypescript("../src/features/profile-export/pptx/career-layout.ts");
const { saveProfileDraft } = await importTypescript("../src/features/profile-source/services/draft-storage.ts");

test("four to six careers use two columns even when a photograph was requested", () => {
  for (const count of [4, 5, 6]) {
    const layout = careerLayout(count, true);
    assert.equal(layout.showImage, false);
    assert.equal(layout.columns, 2);
    // Last row's baseline plus metadata must stay above the 7.05-inch footer.
    assert.ok(2.2 + (layout.rowsPerColumn - 1) * 1.28 + .92 + .25 < 7.05);
  }
});
test("one to three careers retain the photo without overflowing the canvas", () => {
  for (const count of [1, 2, 3]) {
    const layout = careerLayout(count, true);
    assert.equal(layout.showImage, true);
    assert.equal(layout.columns, 1);
    assert.ok(2.2 + (layout.rowsPerColumn - 1) * 1.35 + .92 + .25 < 7.05);
  }
});
test("unavailable browser storage must not report successful saving", async () => {
  await assert.rejects(saveProfileDraft({}), /저장 공간/);
});
test("aborted IndexedDB writes reject and close their connection", async () => {
  let closed = false;
  const transaction = { objectStore: () => ({ put() { queueMicrotask(() => transaction.onabort()); } }), error: null };
  globalThis.indexedDB = { open() {
    const request = { result: { transaction: () => transaction, close() { closed = true; } } };
    queueMicrotask(() => request.onsuccess());
    return request;
  } };
  try {
    await assert.rejects(saveProfileDraft({}), /중단/);
    assert.equal(closed, true);
  } finally { delete globalThis.indexedDB; }
});

test("PPTX export preserves all careers and keeps text inside every template's canvas", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const require = createRequire(import.meta.url);
  const RealPptx = require("pptxgenjs");
  let output;
  // Exercise the real serializer; intercept only file delivery, keeping tests in memory.
  class MemoryPptx extends RealPptx {
    async writeFile() { output = await this.write({ outputType: "nodebuffer" }); return "test.pptx"; }
  }
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = specifier => {
      if (specifier === "pptxgenjs") return MemoryPptx;
      if (specifier.startsWith("@/")) return load(resolve(root, "src", specifier.slice(2)) + ".ts");
      if (specifier.startsWith(".")) return load(resolve(dirname(filename), specifier) + ".ts");
      return require(specifier);
    };
    new Function("require", "module", "exports", compiled)(localRequire, module, module.exports);
    return module.exports;
  }
  const { downloadPptx } = load(resolve(root, "src/features/profile-export/pptx/generate-pptx.ts"));
  const { initialProfile } = load(resolve(root, "src/types/profile.ts"));
  const { designTemplates } = load(resolve(root, "src/features/design-templates/registry/templates.ts"));
  const common = { eyebrow: "활동 기록", body: "검증용 포트폴리오입니다", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" };
  const image = createCanvas(1600, 900);
  const context = image.getContext("2d");
  context.fillStyle = "#5a7964"; context.fillRect(0, 0, 1600, 900);
  const photo = image.toDataURL("image/png");
  for (const template of designTemplates) {
    const profile = {
      ...initialProfile, artistName: "레이아웃 테스트", contact: "test@example.com", templateKey: template.key,
      pdfPageAssets: [{ pageNumber: 1, selected: true, extractedVisuals: [{ id: "fixture", selected: true, role: "portrait", kind: "photo", width: 1600, height: 900, relevanceScore: 1, qualityScore: 1, dataUrl: photo }] }],
      careers: Array.from({ length: 6 }, (_, index) => ({ id: `test-${index}`, year: `202${index}`, title: `검증공연${index + 1}`, organization: "테스트 공연장" })),
      deckPlan: { narrative: "테스트", visualDirection: "테스트", slides: [
        { ...common, type: "cover", title: "레이아웃 테스트", imageRefs: ["pdf-visual-1-fixture"] },
        { ...common, type: "career", title: "주요 활동", careerIndexes: [0, 1, 2, 3, 4, 5], imageRefs: [] },
        { ...common, type: "contact", title: "섭외 문의" },
      ] },
      // Synthetic approval isolates layout from external AI services in this test only.
      deckPlanMeta: { layoutVersion: "editorial-scene-v2", mode: "fallback", releaseReady: true, visualReviewIterations: 1, qualityMetrics: [] },
    };
    const result = await downloadPptx(profile);
    const zip = await JSZip.loadAsync(output);
    const slideFiles = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.equal(slideFiles.length, result.slideCount);
    const xmls = await Promise.all(slideFiles.map(name => zip.file(name).async("string")));
    const pictures = [...xmls.join("").matchAll(/<p:pic>.*?<\/p:pic>/gs)];
    assert.equal(pictures.length, 1, "The selected photograph must survive export");
    const pictureSize = pictures[0][0].match(/<a:ext cx="(\d+)" cy="(\d+)"/);
    assert.ok(pictureSize);
    assert.ok(Math.abs(Number(pictureSize[1]) / Number(pictureSize[2]) - 1600 / 900) < .00001, "Export must preserve the photograph's aspect ratio");
    for (let index = 1; index <= 6; index++) assert.ok(xmls.join("").includes(`검증공연${index}`), `${template.key}: missing career ${index}`);
    for (const xml of xmls) {
      for (const shape of xml.matchAll(/<p:sp>.*?<\/p:sp>/gs)) {
        if (!shape[0].includes("<a:t>")) continue;
        const bounds = shape[0].match(/<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>\s*<a:ext cx="(\d+)" cy="(\d+)"/);
        assert.ok(bounds, "Text shape must have bounds");
        const [x, y, w, h] = bounds.slice(1).map(Number);
        assert.ok(x >= 0 && y >= 0 && x + w <= 12192000 && y + h <= 6858000, `${template.key}: text outside slide`);
      }
    }
  }
});
