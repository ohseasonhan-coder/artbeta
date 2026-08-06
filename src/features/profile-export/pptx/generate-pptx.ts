import { DeckPlan, DeckPlanMeta, DeckSlidePlan, ProfileData } from "@/types/profile";
import { getTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts } from "./deck-facts";

const hex = (value: string) => value.replace("#", "");

interface VisualAsset {
  id: string;
  kind: "representative" | "performance" | "pdf_page";
  pageNumber?: number;
  dataUrl: string;
}

export interface DeckExportResult {
  mode: "ai" | "local";
  provider: string;
  model: string;
  slideCount: number;
}

export function collectDeckAssets(profile: ProfileData): VisualAsset[] {
  const assets: VisualAsset[] = [];
  if (profile.representativeImage) assets.push({ id: "representative", kind: "representative", dataUrl: profile.representativeImage });
  profile.performanceImages.forEach((dataUrl, index) => assets.push({ id: `performance-${index + 1}`, kind: "performance", dataUrl }));
  profile.pdfPageAssets.filter((page) => page.selected).forEach((page) => assets.push({ id: `pdf-page-${page.pageNumber}`, kind: "pdf_page", pageNumber: page.pageNumber, dataUrl: page.previewDataUrl }));
  return assets;
}

export function getDeckAssetData(profile: ProfileData, id: string) {
  return collectDeckAssets(profile).find((asset) => asset.id === id)?.dataUrl;
}

function compactText(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!max || text.length <= max) return max ? text : "";
  const candidate = text.slice(0, max - 1);
  const breakAt = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf(" · "), candidate.lastIndexOf(" "));
  return `${candidate.slice(0, breakAt > max * 0.55 ? breakAt : max - 1).trim()}…`;
}

function fitSlideCopy(slide: DeckSlidePlan): DeckSlidePlan {
  const budgets = {
    cover: [26, 55, 0, 0], about: [34, 160, 3, 34], strengths: [34, 0, 3, 42],
    gallery: [34, 70, 0, 0], career: [34, 70, 0, 0], contact: [30, 110, 2, 36],
  } as const;
  const [title, body, bulletCount, bulletLength] = budgets[slide.type];
  return {
    ...slide,
    eyebrow: compactText(slide.eyebrow, 28),
    title: compactText(slide.title, slide.imageRefs.length && ["about", "contact"].includes(slide.type) ? Math.min(title, 22) : title),
    body: compactText(slide.body, slide.imageRefs.length && slide.type === "about" ? 110 : slide.imageRefs.length && slide.type === "contact" ? 85 : body),
    bullets: slide.bullets.slice(0, bulletCount).map((item) => compactText(item, bulletLength)),
    careerIndexes: slide.careerIndexes.slice(0, 9),
    imageRefs: slide.imageRefs.slice(0, 3),
  };
}

async function makeThumbnail(dataUrl: string) {
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

function fallbackPlan(profile: ProfileData, assets: VisualAsset[]): DeckPlan {
  const deckFacts = buildDeckFacts(profile);
  const slides: DeckSlidePlan[] = [
    { type: "cover", eyebrow: "ARTIST PROFILE", title: profile.artistName || "ARTIST", body: profile.tagline, bullets: [], imageRefs: assets[0] ? [assets[0].id] : [], imagePurpose: "예술인의 첫인상", careerIndexes: [], layout: assets[0] ? "full_bleed" : "editorial" },
    { type: "about", eyebrow: "IDENTITY", title: profile.tagline || `${profile.primaryField}로 만드는 무대`, body: profile.introduction, bullets: [profile.primaryField, profile.region, profile.members].filter(Boolean), imageRefs: assets[1] ? [assets[1].id] : [], imagePurpose: "활동 정체성과 분위기", careerIndexes: [], layout: assets[1] ? "split_right" : "editorial" },
    { type: "strengths", eyebrow: "WHY THIS ARTIST", title: "현장에서 분명해지는 경쟁력", body: "", bullets: (profile.generatedStrengths.length ? profile.generatedStrengths : profile.strengths).slice(0, 3), imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" },
  ];
  const galleryAssets = assets.slice(2);
  galleryAssets.forEach((_, index) => {
    if (index % 3 === 0) slides.push({ type: "gallery", eyebrow: "ON STAGE", title: "사진으로 확인하는 무대의 밀도", body: "", bullets: [], imageRefs: galleryAssets.slice(index, index + 3).map((asset) => asset.id), imagePurpose: "공연 규모와 현장성", careerIndexes: [], layout: "gallery" });
  });
  const careerIndexes = deckFacts.map((_, index) => index);
  for (let index = 0; index < Math.max(1, careerIndexes.length); index += 9) {
    slides.push({ type: "career", eyebrow: "SELECTED HISTORY", title: index ? "이어지는 주요 활동" : "경력으로 증명된 지속적인 활동", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: careerIndexes.slice(index, index + 9), layout: "timeline" });
  }
  const contact: DeckSlidePlan = { type: "contact", eyebrow: "CONTACT", title: "다음 무대를 함께 만들겠습니다", body: [profile.contact, profile.videoUrl, profile.region].filter(Boolean).join("\n"), bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" };
  const requiredCareerSlides = Math.max(1, Math.ceil(deckFacts.length / 8));
  const target = Math.min(16, Math.max(4, profile.pageCount, 5 + requiredCareerSlides));
  const core = slides.filter((slide) => slide.type !== "contact");
  while (core.length > target - 1) {
    const removable = core.findLastIndex((slide) => slide.type === "gallery" || slide.type === "strengths");
    if (removable <= 0) break;
    core.splice(removable, 1);
  }
  while (core.length < target - 1) {
    core.splice(core.length - 1, 0, { type: "gallery", eyebrow: "VISUAL STORY", title: "무대의 장면이 보여주는 예술적 정체성", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" });
  }
  return { narrative: "정체성에서 현장 경쟁력과 검증된 활동을 거쳐 섭외 행동으로 연결", visualDirection: "선명한 타이포그래피와 실제 공연 이미지 중심", slides: [...core, contact].map(fitSlideCopy) };
}

async function requestDeckPlan(profile: ProfileData, assets: VisualAsset[]) {
  const thumbnails = await Promise.all(assets.slice(0, 10).map(async (asset) => ({ ...asset, dataUrl: await makeThumbnail(asset.dataUrl) })));
  const deckFacts = buildDeckFacts(profile);
  const profileFacts = {
    artistName: profile.artistName,
    artistType: profile.artistType,
    primaryField: profile.primaryField,
    secondaryField: profile.secondaryField,
    region: profile.region,
    members: profile.members,
    contact: profile.contact,
    videoUrl: profile.videoUrl,
    careers: deckFacts.map((fact, index) => ({ index, ...fact })),
    extractedFacts: profile.extractedItems.filter((item) => item.status !== "excluded").map(({ type, label, value, pageNumber }) => ({ type, label, value, pageNumber })),
    pdfPageText: profile.pdfPageAssets.filter((page) => page.text.trim()).map(({ pageNumber, text, textSource }) => ({ pageNumber, text: text.slice(0, 6000), textSource })),
    strengths: profile.generatedStrengths.length ? profile.generatedStrengths : profile.strengths,
    experiences: profile.experiences,
    desiredImpression: profile.impressions,
    introduction: profile.introduction,
    tagline: profile.tagline,
    purpose: profile.purpose,
    tone: profile.tone,
    requestedPageCount: profile.pageCount,
  };
  const response = await fetch("/api/ai/plan-deck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: profileFacts, assets: thumbnails }) });
  if (!response.ok) throw new Error("AI PPT 기획을 불러오지 못했습니다.");
  return response.json() as Promise<{ plan: DeckPlan; mode: "ai"; provider: string; model: string; qualityScore?: number; coveredFactCount?: number; totalFactCount?: number }>;
}

export async function prepareDeckPlan(profile: ProfileData): Promise<{ plan: DeckPlan; meta: DeckPlanMeta }> {
  const assets = collectDeckAssets(profile);
  try {
    const result = await requestDeckPlan(profile, assets);
    return { plan: { ...result.plan, slides: result.plan.slides.map(fitSlideCopy) }, meta: { mode: "ai", provider: result.provider, model: result.model, qualityScore: result.qualityScore, coveredFactCount: result.coveredFactCount, totalFactCount: result.totalFactCount } };
  } catch {
    return { plan: fallbackPlan(profile, assets), meta: { mode: "local", provider: "기본 기획", model: "로컬" } };
  }
}

export async function downloadPptx(profile: ProfileData): Promise<DeckExportResult> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const template = getTemplate(profile.templateKey);
  const p = template.palette;
  const assets = collectDeckAssets(profile);
  const prepared = profile.deckPlan && profile.deckPlanMeta
    ? { plan: profile.deckPlan, meta: profile.deckPlanMeta }
    : await prepareDeckPlan(profile);
  const plan = { ...prepared.plan, slides: prepared.plan.slides.map(fitSlideCopy) };
  const exportMeta = prepared.meta;
  const deckFacts = buildDeckFacts(profile);

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Artfolio Studio";
  pptx.subject = `${profile.artistName} 예술인 프로필`;
  pptx.title = `${profile.artistName || "예술인"} Profile`;
  pptx.company = "Artfolio";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };

  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const usedAssets = new Set<string>();
  const pickImages = (slidePlan: DeckSlidePlan) => slidePlan.imageRefs
    .filter((id) => assetMap.has(id) && !usedAssets.has(id))
    .map((id) => { usedAssets.add(id); return assetMap.get(id)!; });
  const addImage = (slide: ReturnType<typeof pptx.addSlide>, asset: VisualAsset, x: number, y: number, w: number, h: number, alt: string, mode: "contain" | "cover" = "contain") => {
    if (mode === "contain") slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: hex(p.surface) }, line: { color: hex(p.muted), transparency: 85, width: 0.5 } });
    slide.addImage({ data: asset.dataUrl, x, y, w, h, sizing: { type: mode, w, h }, altText: alt || `${profile.artistName} 활동 이미지` });
  };
  const addFooter = (slide: ReturnType<typeof pptx.addSlide>, index: number) => {
    slide.addText(`${profile.artistName || "ARTIST"}  ·  ${String(index).padStart(2, "0")}`, { x: 10.3, y: 7.08, w: 2.2, h: 0.18, fontSize: 7, color: hex(p.muted), margin: 0, align: "right" });
  };
  const addEyebrow = (slide: ReturnType<typeof pptx.addSlide>, text: string, light = false) => {
    slide.addText(text || "ARTIST PROFILE", { x: 0.78, y: 0.6, w: 4.8, h: 0.28, fontSize: 10, bold: true, charSpacing: 2.5, color: light ? "FFFFFF" : hex(p.accent), margin: 0 });
  };

  plan.slides.forEach((slidePlan, slideIndex) => {
    const slide = pptx.addSlide();
    const images = pickImages(slidePlan);
    const primaryImage = images[0];
    const isCover = slidePlan.type === "cover";
    slide.background = { color: hex(isCover ? p.background : slideIndex % 2 ? p.surface : p.background) };

    if (isCover) {
      if (primaryImage) {
        addImage(slide, primaryImage, 7.05, 0.45, 5.65, 6.6, slidePlan.imagePurpose, "contain");
      }
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title || profile.artistName || "ARTIST", { x: 0.78, y: 2.1, w: primaryImage ? 5.8 : 11.6, h: 1.35, fontSize: 52, bold: true, color: hex(p.text), margin: 0 });
      slide.addText(slidePlan.body || profile.tagline, { x: 0.82, y: 3.72, w: primaryImage ? 5.65 : 8.8, h: 0.9, fontSize: 22, color: hex(p.muted), margin: 0 });
      slide.addText(`${profile.primaryField} · ${profile.region}`.replace(/^ · | · $/g, ""), { x: 0.82, y: 6.65, w: 6.0, h: 0.25, fontSize: 10, color: hex(p.muted), margin: 0 });
      return;
    }

    if (slidePlan.type === "gallery" && images.length) {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 11.8, h: 0.62, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
      const frames = images.length === 1
        ? [{ x: 0.78, y: 2.05, w: 11.78, h: 4.45 }]
        : images.length === 2
          ? [{ x: 0.78, y: 2.05, w: 7.2, h: 4.45 }, { x: 8.18, y: 2.05, w: 4.38, h: 4.45 }]
          : [{ x: 0.78, y: 2.05, w: 7.2, h: 4.45 }, { x: 8.18, y: 2.05, w: 4.38, h: 2.1 }, { x: 8.18, y: 4.4, w: 4.38, h: 2.1 }];
      images.slice(0, frames.length).forEach((asset, index) => addImage(slide, asset, frames[index].x, frames[index].y, frames[index].w, frames[index].h, slidePlan.imagePurpose, "contain"));
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "career") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 11.7, h: 0.7, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
      const selected = (slidePlan.careerIndexes.length ? slidePlan.careerIndexes : deckFacts.map((_, index) => index)).map((index) => deckFacts[index]).filter(Boolean).slice(0, 8);
      selected.forEach((item, index) => {
        const y = 2.12 + index * 0.55;
        slide.addText(item.date || "—", { x: 0.82, y, w: 1.35, h: 0.24, fontSize: 11, bold: true, color: hex(p.accent), margin: 0 });
        slide.addText(compactText(item.title, 72), { x: 2.25, y: y - 0.02, w: 6.6, h: 0.28, fontSize: 14, bold: true, color: hex(p.text), margin: 0 });
        slide.addText(compactText([item.categoryLabel, item.organization, item.pageNumber ? `${item.pageNumber}p` : ""].filter(Boolean).join(" · "), 52), { x: 9.0, y, w: 3.35, h: 0.24, fontSize: 9, color: hex(p.muted), margin: 0, align: "right" });
        slide.addShape(pptx.ShapeType.line, { x: 2.25, y: y + 0.38, w: 10.1, h: 0, line: { color: hex(p.muted), transparency: 78, width: 0.6 } });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "strengths") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 11.7, h: 0.75, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
      const bullets = slidePlan.bullets.length ? slidePlan.bullets : profile.generatedStrengths;
      bullets.slice(0, 3).forEach((item, index) => {
        const x = 0.82 + index * 4.08;
        slide.addText(`0${index + 1}`, { x, y: 2.45, w: 0.7, h: 0.45, fontSize: 16, bold: true, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.line, { x, y: 3.02, w: 3.45, h: 0, line: { color: hex(p.accent), width: 1.2 } });
        slide.addText(item, { x, y: 3.42, w: 3.45, h: 1.45, fontSize: 24, bold: true, color: hex(p.text), margin: 0, valign: "middle" });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    const imageOnLeft = slidePlan.layout === "split_left";
    if (primaryImage) addImage(slide, primaryImage, imageOnLeft ? 0.42 : 7.55, 0.45, 5.35, 6.6, slidePlan.imagePurpose, "contain");
    const textX = primaryImage && imageOnLeft ? 6.55 : 0.78;
    const textW = primaryImage ? 5.9 : 11.7;
    slide.addText(slidePlan.eyebrow || "ARTIST PROFILE", { x: textX, y: 0.6, w: Math.min(4.8, textW), h: 0.28, fontSize: 10, bold: true, charSpacing: 2.5, color: hex(p.accent), margin: 0 });
    slide.addText(slidePlan.title, { x: textX, y: 1.35, w: textW, h: 1.3, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
    slide.addText(slidePlan.body || (slidePlan.type === "about" ? compactText(profile.introduction, primaryImage ? 110 : 160) : compactText([profile.contact, profile.videoUrl, profile.region].filter(Boolean).join(" · "), primaryImage ? 85 : 110)), { x: textX, y: 3.1, w: primaryImage ? 5.55 : 8.8, h: 1.75, fontSize: 17, color: hex(p.muted), margin: 0, breakLine: false, paraSpaceAfter: 8 });
    if (slidePlan.bullets.length) slide.addText(slidePlan.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), { x: textX, y: 5.15, w: primaryImage ? 5.5 : 8.8, h: 1.15, fontSize: 15, color: hex(p.text), margin: 0, breakLine: false });
    addFooter(slide, slideIndex + 1);
  });

  await pptx.writeFile({ fileName: `${profile.artistName || "artist"}_profile.pptx` });
  return { ...exportMeta, slideCount: plan.slides.length };
}
