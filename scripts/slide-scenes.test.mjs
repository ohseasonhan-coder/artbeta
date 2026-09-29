import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createCanvas } from "@napi-rs/canvas";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url), cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const localRequire = name => name.startsWith("@/") ? load(resolve(root, "src", name.slice(2)) + ".ts") : name.startsWith(".") ? load(resolve(dirname(filename), name) + ".ts") : require(name);
  new Function("require", "module", "exports", code)(localRequire, module, module.exports);
  return module.exports;
}
const { buildSlideScene, containImage, inspectSlideScene, SLIDE_WIDTH, SLIDE_HEIGHT } = load(resolve(root, "src/features/profile-export/pptx/slide-scene.ts"));
const { initialProfile } = load(resolve(root, "src/types/profile.ts"));
const { designTemplates } = load(resolve(root, "src/features/design-templates/registry/templates.ts"));
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > .001 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > .001;

test("contact slide links to the supplied booking channel with an encoded subject", () => {
  const plan = { type: "contact", title: "섭외 문의", body: "", eyebrow: "CONTACT", bullets: [], imageRefs: [], careerIndexes: [], layout: "editorial" };
  for (const [contact, prefix] of [["booking@example.com", "mailto:booking@example.com?subject="], ["010-1234-5678", "tel:01012345678"]]) {
    const scene = buildSlideScene(plan, 0, { ...initialProfile, artistName: "팀 & 공연", contact }, designTemplates[0], new Map());
    const link = scene.nodes.find(node => node.type === "text" && node.original === contact);
    assert.ok(link.href.startsWith(prefix));
    assert.equal(inspectSlideScene(scene).length, 0);
  }
});

test("portrait, panorama and poster fitting preserves ratio and every source edge", () => {
  const frame = { x: .55, y: .6, w: 5.25, h: 6.05 };
  for (const [width, height] of [[800, 1200], [2200, 500], [900, 900], [500, 2400]]) {
    const fitted = containImage(frame, width, height);
    assert.ok(Math.abs(fitted.w / fitted.h - width / height) < 1e-8);
    assert.ok(fitted.x >= frame.x && fitted.y >= frame.y && fitted.x + fitted.w <= frame.x + frame.w + 1e-8 && fitted.y + fitted.h <= frame.y + frame.h + 1e-8);
  }
  assert.equal(containImage(frame, 0, 400), null);
  assert.equal(containImage(frame, NaN, 400), null);
});

test("all slide types and templates keep long Korean copy clear of photos and other text", () => {
  const canvas = createCanvas(1000, 800), context = canvas.getContext("2d");
  const profile = { ...initialProfile, artistName: "동서양의 음악을 연결하는 아티스트 앙상블", contact: "portfolio.booking.department@example.com", careers: Array.from({ length: 6 }, (_, i) => ({ id: String(i), year: `202${i}`, title: "시민과 함께하는 야외 문화예술 축제 초청공연 및 특별기획 무대", organization: "문화예술진흥재단 공연기획사업부" })) };
  let cases = 0;
  for (const template of designTemplates) for (const type of ["cover", "about", "gallery", "strengths", "program", "team", "career", "contact"]) for (const side of ["split_left", "split_right"]) for (const ratio of [[800, 1200], [2200, 600], [900, 900]]) {
    const asset = { id: "image", dataUrl: "fixture", pixelWidth: ratio[0], pixelHeight: ratio[1], visualRole: "portrait" };
    const plan = { type, layout: side, title: "우리의 음악으로 만드는 오래 기억에 남는 특별한 무대", eyebrow: "ARTIST PORTFOLIO", body: "작은 공간부터 야외 축제까지, 관객과 호흡하는 공연을 선보입니다. ".repeat(6), bullets: Array.from({ length: 6 }, (_, i) => `${i + 1} 무대와 관객에 맞춘 다채로운 공연 구성과 프로그램을 제공합니다`), careerIndexes: [0, 1, 2], imageRefs: ["image"], imagePurpose: "테스트 사진" };
    const scene = buildSlideScene(plan, 0, profile, template, new Map([[asset.id, asset]]));
    const content = scene.nodes.filter(node => node.type !== "rect");
    for (const node of content) {
      assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= SLIDE_WIDTH && node.y + node.h <= SLIDE_HEIGHT, `${type}: outside canvas`);
      if (node.type === "text") {
        context.font = `${node.bold ? 700 : 400} ${node.fontSize}px "${node.fontFace}"`;
        for (const line of node.text.split("\n")) assert.ok(context.measureText(line).width <= node.w * 72 + 1, `${type}: text too wide: ${line}`);
        assert.ok(node.text.split("\n").length * node.fontSize * 1.24 <= node.h * 72 + .1, `${type}: text too tall`);
      }
    }
    for (let i = 0; i < content.length; i++) for (let j = i + 1; j < content.length; j++) assert.equal(overlap(content[i], content[j]), false, `${type}: ${content[i].type} overlaps ${content[j].type}`);
    cases++;
  }
  assert.equal(cases, 288);
});

test("oversized copy is flagged and its complete source survives in notes", () => {
  const title = "아주긴띄어쓰기없는한국어아티스트이름".repeat(15);
  const scene = buildSlideScene({ type: "cover", layout: "editorial", title, eyebrow: "", body: "", bullets: [], careerIndexes: [], imageRefs: [] }, 0, initialProfile, designTemplates[0], new Map());
  assert.ok(scene.warnings.length > 0);
  assert.ok(scene.notes.some(note => note.includes(title)));
  assert.ok(scene.nodes.some(node => node.type === "text" && node.truncated));
  assert.ok(inspectSlideScene(scene).length > 0);
});

test("release inspection rejects missing photos, collisions and off-slide geometry", () => {
  const plan = { type: "cover", title: "아티스트", eyebrow: "", body: "", bullets: [], careerIndexes: [], imageRefs: ["missing"], layout: "editorial" };
  const scene = buildSlideScene(plan, 0, initialProfile, designTemplates[0], new Map());
  assert.ok(inspectSlideScene(scene).some(issue => issue.includes("사진")));
  const text = scene.nodes.find(node => node.type === "text");
  scene.warnings = [];
  scene.nodes.push({ ...text });
  assert.ok(inspectSlideScene(scene).some(issue => issue.includes("겹칩니다")));
  scene.nodes.push({ ...text, x: SLIDE_WIDTH });
  assert.ok(inspectSlideScene(scene).some(issue => issue.includes("안전 영역")));
});
