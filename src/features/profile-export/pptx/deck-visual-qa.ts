import type { DeckPlan, DeckSlidePlan, ProfileData } from "@/types/profile";
import type { DesignTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts, formatCareerFact } from "./deck-facts";
import { normalizeKoreanDisplayText } from "./korean-typesetting";

export interface DeckQaFrame {
  index: number;
  type: DeckSlidePlan["type"];
  image: string;
}

const WIDTH = 960;
const HEIGHT = 540;

function color(value: string) {
  return value.startsWith("#") ? value : `#${value}`;
}

function loadImage(dataUrl: string) {
  return new Promise<HTMLImageElement | null>((resolve) => {
    if (!dataUrl || typeof Image === "undefined") return resolve(null);
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

function drawCoverImage(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number, contain = false) {
  const scale = contain ? Math.min(width / image.naturalWidth, height / image.naturalHeight) : Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function canvasLines(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const words = normalizeKoreanDisplayText(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && context.measureText(next).width > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function drawFittedText(context: CanvasRenderingContext2D, value: string, options: { x: number; y: number; width: number; maxLines: number; fontSize: number; minFontSize: number; lineHeight?: number; fontFamily: string; color: string; weight?: number }) {
  const text = normalizeKoreanDisplayText(value);
  if (!text) return { bottom: options.y, truncated: false };
  let fontSize = options.fontSize;
  let lines: string[] = [];
  for (; fontSize >= options.minFontSize; fontSize -= 1) {
    context.font = `${options.weight ?? 400} ${fontSize}px "${options.fontFamily}"`;
    lines = canvasLines(context, text, options.width);
    if (lines.length <= options.maxLines && lines.every((line) => context.measureText(line).width <= options.width)) break;
  }
  fontSize = Math.max(options.minFontSize, fontSize);
  context.font = `${options.weight ?? 400} ${fontSize}px "${options.fontFamily}"`;
  lines = canvasLines(context, text, options.width);
  const truncated = lines.length > options.maxLines;
  lines = lines.slice(0, options.maxLines);
  if (truncated && lines.length) {
    let last = lines.at(-1)!.replace(/[\s.,·;:!?-]+$/g, "");
    while (last && context.measureText(`${last}…`).width > options.width) last = Array.from(last).slice(0, -1).join("");
    lines[lines.length - 1] = `${last}…`;
  }
  context.fillStyle = options.color;
  context.textBaseline = "top";
  const lineHeight = options.lineHeight ?? fontSize * 1.23;
  lines.forEach((line, index) => context.fillText(line, options.x, options.y + lineHeight * index, options.width));
  return { bottom: options.y + lineHeight * lines.length, truncated };
}

function drawEyebrow(context: CanvasRenderingContext2D, text: string, x: number, y: number, template: DesignTemplate, light = false) {
  context.font = `700 12px "${template.typography.body}"`;
  context.fillStyle = light ? "#ffffff" : color(template.palette.accent);
  context.fillText(normalizeKoreanDisplayText(text || "ARTIST PROFILE").slice(0, 30), x, y);
}

function drawFooter(context: CanvasRenderingContext2D, profile: ProfileData, index: number, template: DesignTemplate) {
  context.font = `600 9px "${template.typography.body}"`;
  context.fillStyle = color(template.palette.muted);
  context.textAlign = "right";
  context.fillText(`${profile.artistName || "ARTIST"}  ${String(index + 1).padStart(2, "0")}`, WIDTH - 44, HEIGHT - 26);
  context.textAlign = "left";
}

async function renderFrame(slide: DeckSlidePlan, index: number, profile: ProfileData, template: DesignTemplate, assetData: Map<string, string>) {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) return "";
  const palette = template.palette;
  context.fillStyle = color(index % 2 ? palette.surface : palette.background);
  context.fillRect(0, 0, WIDTH, HEIGHT);
  const imageData = slide.imageRefs[0] ? assetData.get(slide.imageRefs[0]) || "" : "";
  const image = await loadImage(imageData);
  const isFullBleed = Boolean(image && slide.layout === "full_bleed");
  let imageLeft = slide.layout === "split_left";
  let textX = 58;
  let textWidth = image ? 500 : 840;
  let imageFrame: { x: number; y: number; width: number; height: number } | null = null;

  if (isFullBleed && image) {
    drawCoverImage(context, image, 0, 0, WIDTH, HEIGHT);
    const gradient = context.createLinearGradient(0, 0, WIDTH, 0);
    gradient.addColorStop(0, "rgba(4,10,18,.9)");
    gradient.addColorStop(.58, "rgba(4,10,18,.5)");
    gradient.addColorStop(1, "rgba(4,10,18,.08)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    textWidth = 480;
  } else if (image) {
    if (slide.type === "gallery") imageFrame = { x: 386, y: 38, width: 530, height: 458 };
    else if (slide.type === "program") imageFrame = { x: 620, y: 48, width: 296, height: 438 };
    else if (slide.type === "career" || slide.type === "contact" || slide.type === "strengths") imageFrame = { x: 640, y: 62, width: 276, height: 420 };
    else imageFrame = imageLeft ? { x: 30, y: 32, width: 390, height: 476 } : { x: 548, y: 32, width: 382, height: 476 };
    context.fillStyle = color(palette.surface);
    context.fillRect(imageFrame.x, imageFrame.y, imageFrame.width, imageFrame.height);
    context.save();
    context.beginPath();
    context.rect(imageFrame.x, imageFrame.y, imageFrame.width, imageFrame.height);
    context.clip();
    drawCoverImage(context, image, imageFrame.x, imageFrame.y, imageFrame.width, imageFrame.height);
    context.restore();
    if (imageLeft && !["career", "contact", "strengths", "program", "gallery"].includes(slide.type)) textX = 468;
    textWidth = slide.type === "gallery" ? 286 : slide.type === "program" ? 530 : slide.type === "career" || slide.type === "contact" || slide.type === "strengths" ? 530 : 430;
  }

  const light = isFullBleed;
  const mainColor = light ? "#ffffff" : color(palette.text);
  const mutedColor = light ? "rgba(255,255,255,.82)" : color(palette.muted);
  drawEyebrow(context, slide.eyebrow, textX, 48, template, light);

  if (slide.type === "cover") {
    drawFittedText(context, slide.title || profile.artistName, { x: textX, y: 112, width: textWidth, maxLines: 2, fontSize: 62, minFontSize: 43, lineHeight: 65, fontFamily: template.typography.heading, color: mainColor, weight: 700 });
    drawFittedText(context, slide.body || profile.tagline, { x: textX, y: 305, width: textWidth, maxLines: 2, fontSize: 24, minFontSize: 18, lineHeight: 31, fontFamily: template.typography.body, color: mutedColor, weight: 500 });
  } else if (slide.type === "gallery") {
    drawFittedText(context, slide.title, { x: textX, y: 106, width: textWidth, maxLines: 3, fontSize: 43, minFontSize: 32, lineHeight: 49, fontFamily: template.typography.heading, color: mainColor, weight: 700 });
    drawFittedText(context, slide.body, { x: textX, y: 305, width: textWidth, maxLines: 3, fontSize: 19, minFontSize: 16, lineHeight: 26, fontFamily: template.typography.body, color: mutedColor });
  } else {
    const heading = drawFittedText(context, slide.title, { x: textX, y: 86, width: textWidth, maxLines: 2, fontSize: 42, minFontSize: 31, lineHeight: 47, fontFamily: template.typography.heading, color: mainColor, weight: 700 });
    const contentY = Math.max(202, heading.bottom + 26);
    if (slide.type === "career") {
      const facts = buildDeckFacts(profile);
      const selected = slide.careerIndexes.map((factIndex) => facts[factIndex]).filter(Boolean).slice(0, 6);
      const columns = image || selected.length <= 3 ? 1 : 2;
      const rows = Math.ceil(selected.length / columns);
      const columnWidth = textWidth / columns - 16;
      selected.forEach((fact, factIndex) => {
        const column = Math.floor(factIndex / rows);
        const row = factIndex % rows;
        const x = textX + column * (columnWidth + 26);
        const y = contentY + row * 82;
        const display = formatCareerFact(fact, false);
        context.font = `700 13px "${template.typography.body}"`;
        context.fillStyle = color(palette.accent);
        context.fillText(display.date === "—" ? fact.categoryLabel : display.date, x, y);
        drawFittedText(context, display.title, { x, y: y + 20, width: columnWidth, maxLines: 2, fontSize: 18, minFontSize: 16, lineHeight: 21, fontFamily: template.typography.body, color: mainColor, weight: 700 });
        if (display.meta) drawFittedText(context, display.meta, { x, y: y + 61, width: columnWidth, maxLines: 1, fontSize: 13, minFontSize: 12, lineHeight: 15, fontFamily: template.typography.body, color: mutedColor });
        context.strokeStyle = color(palette.muted);
        context.globalAlpha = .32;
        context.beginPath(); context.moveTo(x, y + 78); context.lineTo(x + columnWidth, y + 78); context.stroke(); context.globalAlpha = 1;
      });
    } else if (["strengths", "program", "team"].includes(slide.type)) {
      if (slide.body) drawFittedText(context, slide.body, { x: textX, y: contentY, width: textWidth, maxLines: 2, fontSize: 17, minFontSize: 14, lineHeight: 22, fontFamily: template.typography.body, color: mutedColor });
      const bullets = slide.bullets.slice(0, slide.type === "program" ? 6 : slide.type === "team" ? 4 : 3);
      const bulletY = slide.body ? contentY + 58 : contentY;
      bullets.forEach((bullet, bulletIndex) => {
        const y = bulletY + bulletIndex * (slide.type === "program" ? 47 : 61);
        context.font = `700 12px "${template.typography.body}"`;
        context.fillStyle = color(palette.accent);
        context.fillText(String(bulletIndex + 1).padStart(2, "0"), textX, y + 4);
        drawFittedText(context, bullet, { x: textX + 44, y, width: textWidth - 44, maxLines: 2, fontSize: 19, minFontSize: 15, lineHeight: 23, fontFamily: template.typography.body, color: mainColor, weight: 700 });
      });
    } else if (slide.type === "contact") {
      drawFittedText(context, slide.body, { x: textX, y: contentY, width: textWidth, maxLines: 2, fontSize: 19, minFontSize: 16, fontFamily: template.typography.body, color: mutedColor });
      context.fillStyle = color(palette.accent);
      context.font = `700 12px "${template.typography.body}"`;
      context.fillText("문의", textX, contentY + 92);
      drawFittedText(context, profile.contact || "출연 일정 및 조건 문의", { x: textX + 80, y: contentY + 82, width: textWidth - 80, maxLines: 1, fontSize: 21, minFontSize: 16, fontFamily: template.typography.body, color: mainColor, weight: 700 });
    } else {
      drawFittedText(context, slide.body || profile.introduction, { x: textX, y: contentY, width: textWidth, maxLines: 5, fontSize: 19, minFontSize: 15, lineHeight: 27, fontFamily: template.typography.body, color: mutedColor });
    }
  }
  if (!isFullBleed) drawFooter(context, profile, index, template);
  return canvas.toDataURL("image/jpeg", .5);
}

export async function renderDeckQaFrames(plan: DeckPlan, profile: ProfileData, template: DesignTemplate, assetData: Map<string, string>) {
  if (typeof document === "undefined") return [] as DeckQaFrame[];
  const frames: DeckQaFrame[] = [];
  for (let index = 0; index < plan.slides.length; index += 1) {
    const slide = plan.slides[index];
    const image = await renderFrame(slide, index, profile, template, assetData);
    if (image) frames.push({ index, type: slide.type, image });
  }
  return frames;
}
