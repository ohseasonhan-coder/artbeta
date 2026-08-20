import { DeckPlan, DeckPlanMeta, DeckSlidePlan, ProfileData } from "@/types/profile";
import { getTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts, formatCareerFact } from "./deck-facts";

const hex = (value: string) => value.replace("#", "");

export function normalizeVideoUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function isYouTubeVideoUrl(value: string) {
  const normalized = normalizeVideoUrl(value);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname.replace(/^www\./, "");
  return hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be";
}

const galleryPhotoGuides = [
  "공연 전경\n무대 규모와 전체 구성이 보이는 가로 사진",
  "관객 반응\n현장의 분위기와 호응이 보이는 사진",
  "디테일 컷\n연주·작품·의상 특징이 보이는 근접 사진",
];

interface VisualAsset {
  id: string;
  kind: "representative" | "performance" | "generated" | "pdf_visual";
  visualType?: "photo" | "graphic";
  pageNumber?: number;
  dataUrl: string;
  sourceUrl?: string;
  sourceTitle?: string;
  origin: "representative" | "upload" | "web" | "pdf" | "ai";
  qualityScore?: number;
}

export interface DeckExportResult {
  mode: "ai" | "local";
  provider: string;
  model: string;
  slideCount: number;
}

export function collectDeckAssets(profile: ProfileData): VisualAsset[] {
  const assets: VisualAsset[] = [];
  if (profile.representativeImage) assets.push({ id: "representative", kind: "representative", origin: "representative", dataUrl: profile.representativeImage });
  profile.performanceImages
    .forEach((dataUrl, index) => { if (dataUrl) assets.push({ id: `performance-${index + 1}`, kind: "performance", origin: "upload", dataUrl }); });
  (profile.externalImages ?? []).filter((asset) => asset.source !== "ai" && asset.usageStatus === "approved").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "performance", origin: "web", qualityScore: (asset.relevanceScore + asset.qualityScore) / 2, dataUrl: asset.dataUrl, sourceUrl: asset.sourceUrl, sourceTitle: `${asset.source.toUpperCase()} · ${asset.title}` }));
  (profile.externalImages ?? []).filter((asset) => asset.source === "ai" && asset.usageStatus === "approved").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "generated", origin: "ai", qualityScore: asset.qualityScore, dataUrl: asset.dataUrl, sourceTitle: `AI 연출 이미지 · ${asset.title}${asset.promptBasis ? ` · 근거: ${asset.promptBasis}` : ""}` }));
  profile.pdfPageAssets.filter((page) => page.selected).forEach((page) => page.extractedVisuals?.filter((visual) => visual.selected).forEach((visual) => assets.push({
    id: `pdf-visual-${page.pageNumber}-${visual.id}`,
    kind: "pdf_visual",
    origin: "pdf",
    visualType: visual.kind,
    pageNumber: page.pageNumber,
    dataUrl: visual.dataUrl,
    sourceTitle: `사용자 제공 PDF ${page.pageNumber}페이지에서 분리한 ${visual.kind === "photo" ? "사진" : "그래픽"}`,
  })));
  return assets;
}

export function selectPortfolioAssets(assets: VisualAsset[], limit = 8) {
  const representative = assets.find((asset) => asset.kind === "representative");
  const originScore = { upload: 88, web: 82, pdf: 74, ai: 58, representative: 100 } as const;
  const candidates = assets.filter((asset) => asset !== representative).sort((a, b) => {
    const score = (asset: VisualAsset) => originScore[asset.origin] + (asset.qualityScore ?? 0.7) * 12 + (asset.visualType === "photo" ? 3 : 0);
    return score(b) - score(a);
  });
  return [...(representative ? [representative] : []), ...candidates].slice(0, limit);
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

function splitText(value: string, max: number) {
  const remaining = value.replace(/\s+/g, " ").trim();
  if (!remaining || !max) return remaining ? [remaining] : [];
  const chunks: string[] = [];
  let rest = remaining;
  while (rest.length > max) {
    const candidate = rest.slice(0, max + 1);
    const boundaries = [candidate.lastIndexOf(". "), candidate.lastIndexOf("다. "), candidate.lastIndexOf(" · "), candidate.lastIndexOf(" ")];
    const breakAt = Math.max(...boundaries);
    const cut = breakAt > max * 0.55 ? breakAt + (candidate.slice(breakAt, breakAt + 2) === ". " ? 1 : 0) : max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function paginateSlideCopy(slides: DeckSlidePlan[]) {
  return slides.flatMap((slide) => {
    const bodyLimit = slide.type === "cover" ? 42 : slide.type === "about" ? 105 : slide.type === "contact" ? 60 : 0;
    const bulletLimit = slide.type === "strengths" ? 34 : slide.type === "about" ? 30 : slide.type === "contact" ? 48 : 0;
    const bulletCount = slide.type === "strengths" ? 3 : slide.type === "about" || slide.type === "contact" ? 2 : 0;
    const bodyChunks = bodyLimit ? splitText(slide.body, bodyLimit) : slide.body ? [slide.body] : [];
    const bulletChunks = bulletLimit
      ? slide.type === "contact"
        ? slide.bullets.slice(0, 2).map((item) => compactText(item, bulletLimit))
        : slide.bullets.flatMap((item) => splitText(item, bulletLimit))
      : [];
    const pageCount = Math.max(1, bodyChunks.length, bulletCount ? Math.ceil(bulletChunks.length / bulletCount) : 1);
    if (pageCount === 1) return [slide];
    return Array.from({ length: pageCount }, (_, index): DeckSlidePlan => ({
      ...slide,
      type: slide.type === "cover" && index > 0 ? "about" : slide.type,
      eyebrow: index ? `${slide.eyebrow || "PROFILE"} · CONTINUED` : slide.eyebrow,
      title: index ? `${slide.title} · 계속` : slide.title,
      body: bodyChunks[index] || "",
      bullets: bulletCount ? bulletChunks.slice(index * bulletCount, index * bulletCount + bulletCount) : [],
      imageRefs: index ? [] : slide.imageRefs,
      imagePurpose: index ? "" : slide.imagePurpose,
      layout: index ? "editorial" : slide.layout,
    }));
  });
}

function fitSlideCopy(slide: DeckSlidePlan): DeckSlidePlan {
  const budgets = {
    cover: [26, 42, 0, 0], about: [32, 105, 2, 30], strengths: [32, 0, 3, 34],
    gallery: [32, 42, 0, 0], career: [32, 0, 0, 0], contact: [30, 60, 2, 48],
  } as const;
  const [title, body, bulletCount, bulletLength] = budgets[slide.type];
  return {
    ...slide,
    eyebrow: compactText(slide.eyebrow, 28),
    title: compactText(slide.title, slide.imageRefs.length && ["about", "contact"].includes(slide.type) ? Math.min(title, 22) : title),
    body: compactText(slide.body, body),
    bullets: slide.bullets.slice(0, bulletCount).map((item) => compactText(item, bulletLength)),
    careerIndexes: slide.careerIndexes.slice(0, 6),
    imageRefs: slide.imageRefs.slice(0, 1),
  };
}

export async function makeImageThumbnail(dataUrl: string, maxDimension = 640) {
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
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
  const visualAssets = assets;
  const slides: DeckSlidePlan[] = [
    { type: "cover", eyebrow: "ARTIST PROFILE", title: profile.artistName || "ARTIST", body: compactText(profile.tagline, 42), bullets: [], imageRefs: visualAssets[0] ? [visualAssets[0].id] : [], imagePurpose: "얼굴과 분위기가 선명한 세로 대표사진 · 반신 또는 전신", careerIndexes: [], layout: "split_right" },
    { type: "about", eyebrow: "IDENTITY", title: profile.tagline || `${profile.primaryField}로 만드는 무대`, body: compactText(profile.introduction, 105), bullets: [profile.primaryField, profile.region, profile.members].filter(Boolean).slice(0, 2), imageRefs: visualAssets[1] ? [visualAssets[1].id] : [], imagePurpose: "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장", careerIndexes: [], layout: "split_right" },
    { type: "strengths", eyebrow: "WHY THIS ARTIST", title: "현장에서 분명해지는 경쟁력", body: "", bullets: (profile.generatedStrengths.length ? profile.generatedStrengths : profile.strengths).slice(0, 3), imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" },
  ];
  const galleryAssets = visualAssets.slice(2, 4);
  galleryAssets.forEach((asset, index) => {
    slides.push({
      type: "gallery",
      eyebrow: "ON STAGE",
      title: index ? "무대 밖에서도 이어지는 현장감" : "한눈에 확인하는 공연의 현장감",
      body: "",
      bullets: [],
      imageRefs: [asset.id],
      imagePurpose: index ? galleryPhotoGuides[1] : galleryPhotoGuides[0],
      careerIndexes: [],
      layout: "gallery",
    });
  });
  const careerIndexes = deckFacts.map((_, index) => index);
  for (let index = 0; index < Math.max(1, careerIndexes.length); index += 6) {
    slides.push({ type: "career", eyebrow: "SELECTED HISTORY", title: index ? "이어지는 주요 활동" : "경력으로 증명된 지속적인 활동", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: careerIndexes.slice(index, index + 6), layout: "timeline" });
  }
  const contact: DeckSlidePlan = {
    type: "contact",
    eyebrow: "BOOKING & CONTACT",
    title: "공연·행사 섭외를 문의해 주세요",
    body: [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "),
    bullets: [profile.contact || "연락 가능한 전화번호 또는 이메일을 입력해 주세요", profile.videoUrl || profile.officialUrl].filter(Boolean),
    imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial",
  };
  return { narrative: "정체성, 현장 이미지, 검증된 경력, 섭외 문의 순서로 빠르게 설득", visualDirection: "짧은 문구와 실제 공연 이미지 중심", slides: paginateSlideCopy([...slides, contact]).map(fitSlideCopy) };
}

function ensureVisualCoverage(plan: DeckPlan, assets: VisualAsset[], profile: ProfileData): DeckPlan {
  if (!assets.length) return { ...plan, slides: plan.slides.map((slide) => ({ ...slide, imageRefs: [] })) };
  let slides: DeckSlidePlan[] = plan.slides.map((slide) => ({ ...slide, bullets: [...slide.bullets], careerIndexes: [...slide.careerIndexes], imageRefs: [] }));
  const coverIndex = slides.findIndex((slide) => slide.type === "cover");
  if (coverIndex < 0) slides.unshift({ type: "cover", eyebrow: "ARTIST PROFILE", title: profile.artistName || "ARTIST", body: profile.tagline, bullets: [], imageRefs: [], imagePurpose: "대표사진", careerIndexes: [], layout: "split_right" });
  const normalizedCoverIndex = slides.findIndex((slide) => slide.type === "cover");
  slides[normalizedCoverIndex].imageRefs = [assets[0].id];

  let primaryAboutIndex = -1;
  if (assets[1]) {
    let aboutIndex = slides.findIndex((slide) => slide.type === "about");
    if (aboutIndex < 0) {
      slides.splice(normalizedCoverIndex + 1, 0, { type: "about", eyebrow: "ARTIST IDENTITY", title: profile.tagline || `${profile.primaryField}로 만드는 무대`, body: profile.introduction, bullets: [profile.primaryField, profile.region].filter(Boolean).slice(0, 2), imageRefs: [], imagePurpose: "대표 활동사진", careerIndexes: [], layout: "split_right" });
      aboutIndex = normalizedCoverIndex + 1;
    }
    slides[aboutIndex].imageRefs = [assets[1].id];
    primaryAboutIndex = aboutIndex;
  }

  const requiredGalleryAssets = assets.slice(2, 4);
  let galleryIndexes = slides.map((slide, index) => slide.type === "gallery" ? index : -1).filter((index) => index >= 0);
  while (galleryIndexes.length < requiredGalleryAssets.length) {
    const insertAt = slides.findIndex((slide) => slide.type === "career" || slide.type === "contact");
    slides.splice(insertAt >= 0 ? insertAt : slides.length, 0, { type: "gallery", eyebrow: "SIGNATURE MOMENT", title: galleryIndexes.length ? "또 하나의 대표 장면" : "이 무대를 기억하게 만드는 순간", body: "", bullets: [], imageRefs: [], imagePurpose: "대표 활동을 보여주는 강한 사진 한 장", careerIndexes: [], layout: "gallery" });
    galleryIndexes = slides.map((slide, index) => slide.type === "gallery" ? index : -1).filter((index) => index >= 0);
  }
  const allowedGalleryIndexes = new Set(galleryIndexes.slice(0, requiredGalleryAssets.length));
  slides = slides.filter((slide, index) => slide.type !== "gallery" || allowedGalleryIndexes.has(index));
  galleryIndexes = slides.map((slide, index) => slide.type === "gallery" ? index : -1).filter((index) => index >= 0);
  let nextAssetIndex = assets[1] ? 2 : 1;
  slides.forEach((slide, index) => {
    if (slide.type === "cover" || index === primaryAboutIndex) return;
    const asset = assets[nextAssetIndex % assets.length];
    slide.imageRefs = asset ? [asset.id] : [];
    slide.imagePurpose ||= slide.type === "career" ? "해당 활동과 연결되는 현장 사진" : slide.type === "contact" ? "아티스트를 기억하게 만드는 마무리 사진" : "페이지 메시지를 뒷받침하는 활동 사진";
    slide.layout = index % 2 ? "split_right" : "split_left";
    nextAssetIndex += 1;
  });
  return { ...plan, slides };
}

async function requestDeckPlan(profile: ProfileData, assets: VisualAsset[]) {
  const planningAssets = assets.slice(0, 24);
  const thumbnails = await Promise.all(planningAssets.map(async (asset) => ({ ...asset, dataUrl: await makeImageThumbnail(asset.dataUrl, 640) })));
  const deckFacts = buildDeckFacts(profile);
  const profileFacts = {
    artistName: profile.artistName,
    artistType: profile.artistType,
    primaryField: profile.primaryField,
    secondaryField: profile.secondaryField,
    region: profile.region,
    affiliation: profile.affiliation,
    activeSince: profile.activeSince,
    identityHint: profile.identityHint,
    officialUrl: profile.officialUrl,
    members: profile.members,
    contact: profile.contact,
    videoUrl: profile.videoUrl,
    careers: deckFacts.map((fact, index) => ({ index, ...fact })),
    extractedFacts: profile.extractedItems.filter((item) => item.status !== "excluded").map(({ type, label, value, pageNumber, sourceName, sourceUrl, verificationTier }) => ({ type, label, value, pageNumber, sourceName, sourceUrl, verificationTier })),
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
  if (!response.ok) {
    const details = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    const error = new Error(details?.error || "AI PPT 기획을 불러오지 못했습니다.") as Error & { code?: string };
    error.code = details?.code;
    throw error;
  }
  return response.json() as Promise<{ plan: DeckPlan; mode: "ai"; provider: string; model: string; qualityScore?: number; coveredFactCount?: number; totalFactCount?: number }>;
}

export async function prepareDeckPlan(profile: ProfileData): Promise<{ plan: DeckPlan; meta: DeckPlanMeta }> {
  const assets = selectPortfolioAssets(collectDeckAssets(profile));
  try {
    const result = await requestDeckPlan(profile, assets);
    const coveredPlan = ensureVisualCoverage(result.plan, assets, profile);
    return { plan: { ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides).map(fitSlideCopy) }, meta: { mode: "ai", provider: result.provider, model: result.model, qualityScore: result.qualityScore, coveredFactCount: result.coveredFactCount, totalFactCount: result.totalFactCount } };
  } catch (error) {
    const failure = error as Error & { code?: string };
    return {
      plan: fallbackPlan(profile, assets),
      meta: {
        mode: "local",
        provider: "기본 기획",
        model: "로컬",
        warning: failure.message || "Gemini PPT 기획을 완료하지 못했습니다.",
        errorCode: failure.code || "DECK_PLANNING_FAILED",
      },
    };
  }
}

export async function downloadPptx(profile: ProfileData): Promise<DeckExportResult> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const template = getTemplate(profile.templateKey);
  const p = template.palette;
  const assets = selectPortfolioAssets(collectDeckAssets(profile));
  const prepared = profile.deckPlan && profile.deckPlanMeta
    ? { plan: profile.deckPlan, meta: profile.deckPlanMeta }
    : await prepareDeckPlan(profile);
  const coveredPlan = ensureVisualCoverage(prepared.plan, assets, profile);
  const plan = { ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides).map(fitSlideCopy) };
  const exportMeta = prepared.meta;
  const deckFacts = buildDeckFacts(profile);

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Artfolio Studio";
  pptx.subject = `${profile.artistName} 예술인 프로필`;
  pptx.title = `${profile.artistName || "예술인"} Profile`;
  pptx.company = "Artfolio";
  pptx.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };

  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const pickImages = (slidePlan: DeckSlidePlan) => slidePlan.imageRefs
    .filter((id) => assetMap.has(id))
    .map((id) => assetMap.get(id)!);
  const addImage = (slide: ReturnType<typeof pptx.addSlide>, asset: VisualAsset, x: number, y: number, w: number, h: number, alt: string, mode: "contain" | "cover" = "contain") => {
    if (mode === "contain") slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: hex(p.surface) }, line: { color: hex(p.muted), transparency: 85, width: 0.5 } });
    slide.addImage({ data: asset.dataUrl, x, y, w, h, sizing: { type: mode, w, h }, altText: alt || `${profile.artistName} 활동 이미지` });
    if (asset.kind === "generated") slide.addText("AI 연출 이미지", { x: x + 0.12, y: y + h - 0.34, w: 1.18, h: 0.22, fontSize: 7, bold: true, color: "FFFFFF", fill: { color: "1B4D3E", transparency: 8 }, margin: 0.04, align: "center", breakLine: false });
  };
  const addImagePlaceholder = (slide: ReturnType<typeof pptx.addSlide>, x: number, y: number, w: number, h: number, guide: string) => {
    slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: hex(p.surface), transparency: 35 }, line: { color: hex(p.muted), transparency: 45, width: 1 } });
    slide.addText(`PHOTO NEEDED\n${guide}`, { x: x + 0.22, y: y + h / 2 - 0.45, w: w - 0.44, h: 0.9, fontSize: 13, bold: false, color: hex(p.muted), margin: 0, align: "center", valign: "middle", breakLine: false });
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
    const factSourceNotes = slidePlan.careerIndexes.map((index) => deckFacts[index]).filter((fact) => fact?.sourceUrl).map((fact) => `${fact.sourceName || "웹 참고 출처"}: ${fact.sourceUrl}${fact.verificationTier === "reference" ? " (참고 자료 · 사실 확인 필요)" : ""}`);
    const sourceNotes = [...images.flatMap((asset) => asset.sourceUrl ? [`${asset.sourceTitle || "웹 이미지"}: ${asset.sourceUrl}`] : asset.kind === "generated" ? [asset.sourceTitle || "AI 연출 이미지 · 실제 현장 증빙이 아님"] : asset.kind === "pdf_visual" ? [asset.sourceTitle || `사용자 제공 PDF ${asset.pageNumber ?? ""}페이지에서 분리한 이미지`] : []), ...factSourceNotes];
    if (sourceNotes.length) slide.addNotes(`[Sources]\n${sourceNotes.join("\n")}`);

    if (isCover) {
      if (primaryImage) {
        addImage(slide, primaryImage, 7.05, 0.45, 5.65, 6.6, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      } else addImagePlaceholder(slide, 7.05, 0.45, 5.65, 6.6, slidePlan.imagePurpose || "얼굴이 선명한 세로 대표사진 · 반신 또는 전신");
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title || profile.artistName || "ARTIST", { x: 0.78, y: 2.1, w: 5.8, h: 1.35, fontSize: 52, bold: true, color: hex(p.text), margin: 0 });
      slide.addText(slidePlan.body || profile.tagline, { x: 0.82, y: 3.72, w: 5.65, h: 0.9, fontSize: 24, color: hex(p.muted), margin: 0 });
      slide.addText(`${profile.primaryField} · ${profile.region}`.replace(/^ · | · $/g, ""), { x: 0.82, y: 6.65, w: 6.0, h: 0.25, fontSize: 10, color: hex(p.muted), margin: 0 });
      return;
    }

    if (slidePlan.type === "gallery") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.28, w: 4.05, h: 1.55, fontSize: 40, bold: true, color: hex(p.text), margin: 0, valign: "middle" });
      if (slidePlan.body) slide.addText(slidePlan.body, { x: 0.82, y: 3.25, w: 3.85, h: 1.1, fontSize: 18, color: hex(p.muted), margin: 0, breakLine: false, valign: "middle" });
      if (primaryImage) addImage(slide, primaryImage, 5.15, 0.52, 7.45, 6.32, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      else addImagePlaceholder(slide, 5.15, 0.52, 7.45, 6.32, slidePlan.imagePurpose || "대표 활동을 한눈에 보여주는 강한 가로 사진");
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "career") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 7.25, h: 0.7, fontSize: 35, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      else addImagePlaceholder(slide, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose || "해당 경력과 연결되는 활동 사진");
      const selected = (slidePlan.careerIndexes.length ? slidePlan.careerIndexes : deckFacts.map((_, index) => index)).map((index) => deckFacts[index]).filter(Boolean).slice(0, 6);
      selected.forEach((item, index) => {
        const display = formatCareerFact(item, false);
        const y = 2.05 + index * 0.78;
        slide.addText(display.date, { x: 0.82, y, w: 0.85, h: 0.32, fontSize: 14, bold: true, color: hex(p.accent), margin: 0, fit: "shrink" });
        slide.addText(display.title, { x: 1.82, y: y - 0.03, w: 6.25, h: 0.34, fontSize: 14, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
        if (display.meta) slide.addText(display.meta, { x: 1.82, y: y + 0.32, w: 6.25, h: 0.23, fontSize: 10, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
        slide.addShape(pptx.ShapeType.line, { x: 1.82, y: y + 0.63, w: 6.25, h: 0, line: { color: hex(p.muted), transparency: 78, width: 0.6 } });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "contact") {
      addEyebrow(slide, "BOOKING & CONTACT");
      if (primaryImage) addImage(slide, primaryImage, 8.55, 0.65, 4.15, 6.25, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      else addImagePlaceholder(slide, 8.55, 0.65, 4.15, 6.25, slidePlan.imagePurpose || "아티스트를 기억하게 만드는 마무리 사진");
      slide.addText(slidePlan.title || "공연·행사 섭외를 문의해 주세요", { x: 0.78, y: 1.35, w: 7.15, h: 1.15, fontSize: 42, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      slide.addText(slidePlan.body || [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "), { x: 0.82, y: 2.85, w: 7.1, h: 0.5, fontSize: 17, color: hex(p.muted), margin: 0 });
      const contactText = profile.contact || slidePlan.bullets.find((item) => !/^https?:\/\//i.test(item)) || "연락 가능한 전화번호 또는 이메일을 입력해 주세요";
      const videoUrl = normalizeVideoUrl(profile.videoUrl || profile.officialUrl || slidePlan.bullets.find((item) => /^https?:\/\//i.test(item)) || "");
      slide.addText("CONTACT", { x: 0.82, y: 4.05, w: 1.35, h: 0.25, fontSize: 9, bold: true, charSpacing: 1.5, color: hex(p.accent), margin: 0 });
      slide.addText(contactText, { x: 2.25, y: 3.94, w: 5.65, h: 0.45, fontSize: 19, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
      if (videoUrl) {
        const videoLabel = isYouTubeVideoUrl(videoUrl) ? "▶  YouTube 대표 영상 바로 보기" : "▶  대표 영상 바로 보기";
        slide.addText("VIDEO", { x: 0.82, y: 5.14, w: 1.35, h: 0.25, fontSize: 9, bold: true, charSpacing: 1.5, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.roundRect, { x: 2.25, y: 4.88, w: 4.25, h: 0.68, rectRadius: 0.08, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 }, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" } });
        slide.addText(videoLabel, { x: 2.55, y: 5.08, w: 3.72, h: 0.25, fontSize: 16, bold: true, color: "FFFFFF", margin: 0, align: "center", breakLine: false, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" } });
        slide.addText(compactText(videoUrl, 42), { x: 6.65, y: 5.05, w: 1.25, h: 0.28, fontSize: 9, color: hex(p.muted), margin: 0, breakLine: false, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" }, underline: { color: hex(p.muted) }, fit: "shrink" });
      }
      slide.addText("일정과 행사 정보를 보내주시면 맞춤 구성으로 답변드리겠습니다.", { x: 0.82, y: 6.48, w: 9.2, h: 0.35, fontSize: 14, color: hex(p.muted), margin: 0 });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "strengths") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 7.2, h: 0.75, fontSize: 35, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      else addImagePlaceholder(slide, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose || "핵심 강점을 보여주는 활동 사진");
      const bullets = slidePlan.bullets.length ? slidePlan.bullets : profile.generatedStrengths;
      bullets.slice(0, 3).forEach((item, index) => {
        const y = 2.35 + index * 1.35;
        slide.addText(`0${index + 1}`, { x: 0.82, y, w: 0.55, h: 0.35, fontSize: 15, bold: true, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.line, { x: 1.52, y: y + 0.16, w: 0.65, h: 0, line: { color: hex(p.accent), width: 1.2 } });
        slide.addText(item, { x: 2.42, y: y - 0.12, w: 5.55, h: 0.75, fontSize: 21, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    const imageOnLeft = slidePlan.layout === "split_left";
    const expectsImage = slidePlan.type === "about" && Boolean(slidePlan.imagePurpose);
    if (primaryImage) addImage(slide, primaryImage, imageOnLeft ? 0.42 : 7.55, 0.45, 5.35, 6.6, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
    else if (expectsImage) addImagePlaceholder(slide, imageOnLeft ? 0.42 : 7.55, 0.45, 5.35, 6.6, slidePlan.imagePurpose);
    const hasImageFrame = Boolean(primaryImage || expectsImage);
    const textX = hasImageFrame && imageOnLeft ? 6.55 : 0.78;
    const textW = hasImageFrame ? 5.9 : 11.7;
    slide.addText(slidePlan.eyebrow || "ARTIST PROFILE", { x: textX, y: 0.6, w: Math.min(4.8, textW), h: 0.28, fontSize: 10, bold: true, charSpacing: 2.5, color: hex(p.accent), margin: 0 });
    slide.addText(slidePlan.title, { x: textX, y: 1.35, w: textW, h: 1.3, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
    slide.addText(slidePlan.body || compactText(profile.introduction, 105), { x: textX, y: 3.1, w: hasImageFrame ? 5.55 : 8.8, h: 1.75, fontSize: 17, color: hex(p.muted), margin: 0, breakLine: false, paraSpaceAfter: 8 });
    if (slidePlan.bullets.length) slide.addText(slidePlan.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), { x: textX, y: 5.15, w: hasImageFrame ? 5.5 : 8.8, h: 1.15, fontSize: 16, color: hex(p.text), margin: 0, breakLine: false });
    addFooter(slide, slideIndex + 1);
  });

  await pptx.writeFile({ fileName: `${profile.artistName || "artist"}_profile.pptx` });
  return { ...exportMeta, slideCount: plan.slides.length };
}
