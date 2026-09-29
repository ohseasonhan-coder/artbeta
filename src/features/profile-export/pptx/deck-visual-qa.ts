import type { DeckPlan, ProfileData } from "@/types/profile";
import type { DesignTemplate } from "@/features/design-templates/registry/templates";
import { buildSlideScene, SLIDE_HEIGHT, SLIDE_WIDTH, type SceneAsset } from "./slide-scene";

export interface DeckQaFrame { index: number; type: DeckPlan["slides"][number]["type"]; image: string }

function loadImage(src: string) {
  return new Promise<HTMLImageElement | null>(resolve => {
    const image = new Image();
    const timer = window.setTimeout(() => resolve(null), 12000);
    image.onload = () => { window.clearTimeout(timer); resolve(image); };
    image.onerror = () => { window.clearTimeout(timer); resolve(null); };
    image.src = src;
  });
}

export async function renderDeckQaFrames(plan: DeckPlan, profile: ProfileData, template: DesignTemplate, assets: Map<string, SceneAsset>) {
  if (typeof document === "undefined") return [] as DeckQaFrame[];
  await document.fonts.ready;
  const frames: DeckQaFrame[] = [];
  const images = new Map<string, HTMLImageElement>();
  await Promise.all([...assets.values()].map(async asset => { const image = await loadImage(asset.dataUrl); if (image) images.set(asset.id, image); }));
  const available = new Map([...assets].filter(([id]) => images.has(id)).map(([id, asset]) => [id, { ...asset, pixelWidth: images.get(id)!.naturalWidth, pixelHeight: images.get(id)!.naturalHeight }]));
  for (const [index, planSlide] of plan.slides.entries()) {
    const scene = buildSlideScene(planSlide, index, profile, template, available);
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext("2d");
    if (!context) continue;
    const unit = canvas.width / SLIDE_WIDTH;
    context.fillStyle = scene.background; context.fillRect(0, 0, canvas.width, canvas.height);
    for (const node of scene.nodes) {
      const x = node.x * unit, y = node.y * unit, w = node.w * unit, h = node.h * unit;
      context.save(); context.beginPath(); context.rect(x, y, w, h); context.clip();
      if (node.type === "rect") { context.fillStyle = node.color; context.fillRect(x, y, w, h); }
      else if (node.type === "image") { const image = images.get(node.asset.id); if (image) context.drawImage(image, x, y, w, h); }
      else {
        const size = node.fontSize / 72 * unit;
        context.font = `${node.bold ? 700 : 400} ${size}px "${node.fontFace}", "Noto Sans KR", sans-serif`;
        context.fillStyle = node.color; context.textBaseline = "top";
        node.text.split("\n").forEach((line, lineIndex) => context.fillText(line, x, y + lineIndex * size * 1.24));
      }
      context.restore();
    }
    frames.push({ index, type: planSlide.type, image: canvas.toDataURL("image/jpeg", .86) });
  }
  return frames;
}
