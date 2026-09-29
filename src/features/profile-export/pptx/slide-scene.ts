import type { DeckSlidePlan, ProfileData, ProfileVisualRole } from "@/types/profile";
import type { DesignTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts, formatCareerFact } from "./deck-facts";
import { fitKoreanTextBoxInches } from "./korean-typesetting";
import { careerLayout } from "./career-layout";

export const SLIDE_WIDTH = 40 / 3;
export const SLIDE_HEIGHT = 7.5;
export const SLIDE_LAYOUT_VERSION = "editorial-scene-v2";
export interface Frame { x: number; y: number; w: number; h: number }
export interface SceneAsset {
  id: string; dataUrl: string; pixelWidth?: number; pixelHeight?: number;
  visualRole?: ProfileVisualRole; visualType?: "photo" | "graphic";
  kind?: string; sourceUrl?: string; sourceTitle?: string;
}
export type SceneNode =
  | (Frame & { type: "text"; text: string; original: string; fontSize: number; fontFace: string; color: string; bold: boolean; truncated: boolean; href?: string })
  | (Frame & { type: "image"; asset: SceneAsset })
  | (Frame & { type: "rect"; color: string });
export interface SlideScene { background: string; nodes: SceneNode[]; notes: string[]; warnings: string[] }

export function inspectSlideScene(scene: SlideScene): string[] {
  const issues = [...scene.warnings];
  const content = scene.nodes.filter(node => node.type !== "rect");
  for (const node of content) {
    if (![node.x, node.y, node.w, node.h].every(Number.isFinite) || node.x < 0 || node.y < 0 || node.w <= 0 || node.h <= 0 || node.x + node.w > SLIDE_WIDTH + .001 || node.y + node.h > SLIDE_HEIGHT + .001) issues.push("콘텐츠가 슬라이드 안전 영역을 벗어났습니다.");
  }
  for (let i = 0; i < content.length; i++) for (let j = i + 1; j < content.length; j++) {
    const a = content[i], b = content[j];
    if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > .01 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > .01) issues.push("사진과 문구 또는 문구 영역이 겹칩니다.");
  }
  return [...new Set(issues)];
}

/** Whole-image placement: no stretching and no automatic cropping of faces or posters. */
export function containImage(frame: Frame, width: number, height: number): Frame | null {
  if (![width, height, frame.w, frame.h].every(value => Number.isFinite(value) && value > 0)) return null;
  const scale = Math.min(frame.w / width, frame.h / height);
  const w = width * scale, h = height * scale;
  return { x: frame.x + (frame.w - w) / 2, y: frame.y + (frame.h - h) / 2, w, h };
}

function safeLink(value: string) {
  if (!value.trim()) return undefined;
  try { const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}

/** One geometry contract shared by PowerPoint, the browser, and visual review. */
export function buildSlideScene(plan: DeckSlidePlan, index: number, profile: ProfileData, template: DesignTemplate, assets: Map<string, SceneAsset>): SlideScene {
  const p = template.palette;
  const scene: SlideScene = { background: index % 2 ? p.surface : p.background, nodes: [], notes: [], warnings: [] };
  const facts = buildDeckFacts(profile);
  const careers = plan.careerIndexes.map(i => facts[i]).filter(Boolean).slice(0, 6);
  let asset = plan.imageRefs.map(id => assets.get(id)).find(item => item?.dataUrl);
  if (plan.imageRefs.length && !asset) scene.warnings.push("배정된 사진을 사용할 수 없습니다. 사진을 다시 선택해 주세요.");
  if (asset && (!(asset.pixelWidth && asset.pixelWidth > 0) || !(asset.pixelHeight && asset.pixelHeight > 0))) {
    scene.warnings.push("사진의 크기를 읽을 수 없습니다. 사진을 다시 올려 주세요.");
    asset = undefined;
  }
  if (plan.type === "career" && !careerLayout(careers.length, !!asset).showImage) asset = undefined;
  const photoLeft = plan.type === "cover" ? template.coverImageSide === "left" : plan.layout === "split_left";
  let x = .75, w = 11.83;
  let photo: Frame | undefined;
  const landscape = !!asset && (asset.pixelWidth ?? 0) / (asset.pixelHeight ?? 1) >= 1.25;
  const featurePhoto = !!asset && landscape && plan.type === "gallery";
  if (asset) {
    const photoW = plan.type === "gallery" ? 7.6 : plan.type === "cover" && landscape ? 7 : ["cover", "about", "team"].includes(plan.type) ? 5.25 : 4.05;
    photo = { x: photoLeft ? .55 : SLIDE_WIDTH - .55 - photoW, y: .6, w: photoW, h: 6.05 };
    x = photoLeft ? photo.x + photo.w + .55 : .75;
    w = photoLeft ? SLIDE_WIDTH - .75 - x : photo.x - .55 - x;
    if (featurePhoto) photo = { x: .75, y: 1.15, w: 11.83, h: 4.7 };
  }
  const rect = (frame: Frame, color: string) => scene.nodes.push({ type: "rect", ...frame, color });
  const text = (value: string, frame: Frame, size = 18, lines = 2, bold = false, color = p.text, href?: string) => {
    if (!value.trim()) return;
    const fit = fitKoreanTextBoxInches(value, { widthInches: frame.w, heightInches: frame.h, maxLines: lines, preferredFontSize: size, minFontSize: Math.max(9, size * .78), lineHeight: 1.24 });
    // Use the Korean font explicitly to avoid platform-dependent Latin-font fallback.
    const fontFace = template.composition === "heritage" && bold ? "Batang" : "Malgun Gothic";
    scene.nodes.push({ type: "text", ...frame, text: fit.text, original: value, fontSize: fit.fontSize, fontFace, bold, color, truncated: fit.truncated, href });
    if (fit.truncated) scene.warnings.push(`문구를 줄이거나 나누어 주세요: ${value}`);
  };

  rect({ x: .55, y: .25, w: template.composition === "dynamic" ? 2.1 : .6, h: .055 }, p.accent);
  if (template.composition === "human") rect({ x: 0, y: 0, w: .12, h: SLIDE_HEIGHT }, p.accent);
  if (photo && asset) {
    const placement = containImage(photo, asset.pixelWidth ?? 0, asset.pixelHeight ?? 0);
    // The browser can discover dimensions after load. Unknown dimensions are never stretched.
    scene.nodes.push({ type: "image", ...(placement ?? photo), asset });
    if (asset.kind === "generated") text("AI 연출 이미지", { x: photo.x + .12, y: 6.75, w: photo.w - .24, h: .2 }, 9, 1, false, p.muted);
    if (asset.sourceTitle || asset.sourceUrl) scene.notes.push([asset.sourceTitle, asset.sourceUrl].filter(Boolean).join(": "));
  }
  if (featurePhoto) {
    text(plan.eyebrow || "SELECTED WORK", { x: .75, y: .62, w: 11.83, h: .25 }, 10, 1, true, p.accent);
    text(plan.title, { x: .75, y: 6.06, w: 7.5, h: .65 }, 25, 2, true);
    text(plan.body, { x: 8.65, y: 6.06, w: 3.93, h: .65 }, 13, 3, false, p.muted);
    text(profile.artistName, { x: .75, y: 7.08, w: 10.4, h: .22 }, 9, 1, false, p.muted);
    text(String(index + 1).padStart(2, "0"), { x: 12.1, y: 7.08, w: .5, h: .22 }, 9, 1, true, p.accent);
    scene.notes.push(...scene.nodes.flatMap(node => node.type === "text" && node.truncated ? [`전체 문구: ${node.original}`] : []));
    return scene;
  }
  const eyebrow = { x, y: .62, w, h: .25 };
  text(plan.eyebrow || "ARTIST PORTFOLIO", eyebrow, 10, 1, true, p.accent);
  const titleFrame = { x, y: 1.17, w, h: plan.type === "cover" ? 1.85 : 1.15 };
  text(plan.title || profile.artistName, titleFrame, plan.type === "cover" ? (landscape ? 36 : 44) : plan.type === "gallery" ? 30 : 34, plan.type === "cover" ? 3 : 2, true);

  if (plan.type === "cover") {
    text(plan.body || profile.tagline, { x, y: 3.65, w, h: 1.25 }, landscape ? 18 : 21, 4, false, p.muted);
    rect({ x, y: 5.28, w: .9, h: .045 }, p.accent);
    text([profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "), { x, y: 5.6, w, h: .55 }, 13, 2, false, p.muted);
  } else if (plan.type === "career") {
    const { columns, rowsPerColumn } = careerLayout(careers.length, !!asset);
    const gap = .45, colW = (w - gap * (columns - 1)) / columns;
    careers.forEach((fact, i) => {
      const display = formatCareerFact(fact, false);
      const cx = x + Math.floor(i / rowsPerColumn) * (colW + gap), y = 2.65 + (i % rowsPerColumn) * 1.23;
      text([display.date === "—" ? "" : display.date, fact.categoryLabel].filter(Boolean).join(" · "), { x: cx, y, w: colW, h: .22 }, 10, 1, true, p.accent);
      text(display.title, { x: cx, y: y + .29, w: colW, h: .57 }, 17, 2, true);
      text(display.meta, { x: cx, y: y + .9, w: colW, h: .22 }, 10, 1, false, p.muted);
      scene.notes.push([display.date, display.title, display.meta, fact.sourceUrl].filter(Boolean).join(" · "));
    });
  } else if (["strengths", "program", "team"].includes(plan.type)) {
    const count = plan.type === "program" ? 6 : plan.type === "team" ? 4 : 3;
    text(plan.body, { x, y: 2.52, w, h: .58 }, 16, 2, false, p.muted);
    const top = plan.body ? 3.28 : 2.65;
    const bullets = (plan.bullets.length ? plan.bullets : profile.generatedStrengths).slice(0, count);
    const columns = plan.type === "program" ? 2 : 1;
    const rows = Math.max(1, Math.ceil(bullets.length / columns));
    const colW = (w - .4 * (columns - 1)) / columns;
    const rowH = Math.min(1.15, (6.45 - top) / rows);
    bullets.forEach((bullet, i) => {
      const cx = x + Math.floor(i / rows) * (colW + .4), y = top + (i % rows) * rowH;
      text(String(i + 1).padStart(2, "0"), { x: cx, y, w: .35, h: .25 }, 11, 1, true, p.accent);
      text(bullet, { x: cx + .48, y, w: colW - .48, h: rowH - .18 }, plan.type === "strengths" ? 21 : 17, 3, true);
    });
  } else if (plan.type === "contact") {
    text(plan.body, { x, y: 2.65, w, h: .7 }, 17, 2, false, p.muted);
    text("섭외 문의", { x, y: 3.65, w, h: .25 }, 11, 1, true, p.accent);
    const email = profile.contact.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const phone = profile.contact.match(/(?:\+82[- .]?)?0?\d{1,3}[- .]?\d{3,4}[- .]?\d{4}/)?.[0];
    const contactHref = email ? `mailto:${email}?subject=${encodeURIComponent(`${profile.artistName} 섭외 문의`)}` : phone ? `tel:${phone.replace(/[^+\d]/g, "")}` : undefined;
    text(profile.contact || "공식 채널을 통해 문의해 주세요", { x, y: 4.08, w, h: .85 }, 22, 3, true, p.text, contactHref);
    const url = safeLink(profile.videoUrl || profile.officialUrl);
    if (url) text(profile.videoUrl ? "대표 영상 보기 ↗" : "공식 채널 보기 ↗", { x, y: 5.24, w, h: .42 }, 17, 1, true, p.accent, url);
    text("행사 일정·장소·예상 관객을 알려주세요.", { x, y: 6.02, w, h: .46 }, 13, 2, false, p.muted);
  } else {
    text(plan.body || (plan.type === "about" ? profile.introduction : ""), { x, y: 2.7, w, h: plan.type === "gallery" ? 2 : 1.85 }, 19, 5, false, p.muted);
    plan.bullets.slice(0, 3).forEach((bullet, i) => text(bullet, { x, y: 4.85 + i * .5, w, h: .43 }, 15, 2, true));
  }
  rect({ x: .75, y: 6.95, w: 11.83, h: .012 }, p.muted);
  text(profile.artistName, { x: .75, y: 7.08, w: 10.4, h: .22 }, 9, 1, false, p.muted);
  text(String(index + 1).padStart(2, "0"), { x: 12.1, y: 7.08, w: .5, h: .22 }, 9, 1, true, p.accent);
  scene.notes.push(...scene.nodes.filter((node): node is Extract<SceneNode, { type: "text" }> => node.type === "text" && node.truncated).map(node => `전체 문구: ${node.original}`));
  return scene;
}
