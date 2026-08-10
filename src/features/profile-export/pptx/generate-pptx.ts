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
  kind: "representative" | "performance" | "generated" | "pdf_page";
  pageNumber?: number;
  dataUrl: string;
  sourceUrl?: string;
  sourceTitle?: string;
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
  profile.performanceImages
    .forEach((dataUrl, index) => { if (dataUrl) assets.push({ id: `performance-${index + 1}`, kind: "performance", dataUrl }); });
  (profile.externalImages ?? []).filter((asset) => asset.source !== "ai").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "performance", dataUrl: asset.dataUrl, sourceUrl: asset.sourceUrl, sourceTitle: `${asset.source.toUpperCase()} · ${asset.title}` }));
  (profile.externalImages ?? []).filter((asset) => asset.source === "ai").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "generated", dataUrl: asset.dataUrl, sourceTitle: `AI 연출 이미지 · ${asset.title}${asset.promptBasis ? ` · 근거: ${asset.promptBasis}` : ""}` }));
  profile.pdfPageAssets.filter((page) => page.selected).forEach((page) => assets.push({
    id: `pdf-page-${page.pageNumber}`,
    kind: "pdf_page",
    pageNumber: page.pageNumber,
    dataUrl: page.previewDataUrl,
    sourceTitle: `PDF ${page.pageNumber}페이지${page.text.trim() ? ` · ${compactText(page.text, 180)}` : " · 이미지 자료"}`,
  }));
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
    careerIndexes: slide.careerIndexes.slice(0, 10),
    imageRefs: slide.imageRefs.slice(0, 3),
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
  const visualAssets = assets.filter((asset) => asset.kind !== "pdf_page");
  const pdfAssets = assets.filter((asset) => asset.kind === "pdf_page");
  const slides: DeckSlidePlan[] = [
    { type: "cover", eyebrow: "ARTIST PROFILE", title: profile.artistName || "ARTIST", body: compactText(profile.tagline, 42), bullets: [], imageRefs: visualAssets[0] ? [visualAssets[0].id] : [], imagePurpose: "얼굴과 분위기가 선명한 세로 대표사진 · 반신 또는 전신", careerIndexes: [], layout: "split_right" },
    { type: "about", eyebrow: "IDENTITY", title: profile.tagline || `${profile.primaryField}로 만드는 무대`, body: compactText(profile.introduction, 105), bullets: [profile.primaryField, profile.region, profile.members].filter(Boolean).slice(0, 2), imageRefs: visualAssets[1] ? [visualAssets[1].id] : [], imagePurpose: "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장", careerIndexes: [], layout: "split_right" },
    { type: "strengths", eyebrow: "WHY THIS ARTIST", title: "현장에서 분명해지는 경쟁력", body: "", bullets: (profile.generatedStrengths.length ? profile.generatedStrengths : profile.strengths).slice(0, 3), imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial" },
  ];
  const galleryAssets = visualAssets.slice(2);
  const galleryPageCount = Math.max(pdfAssets.length ? 0 : 1, Math.ceil(galleryAssets.length / 3));
  Array.from({ length: galleryPageCount }, (_, index) => {
    slides.push({
      type: "gallery",
      eyebrow: "ON STAGE",
      title: index ? "무대 밖에서도 이어지는 현장감" : "한눈에 확인하는 공연의 현장감",
      body: "",
      bullets: [],
      imageRefs: galleryAssets.slice(index * 3, index * 3 + 3).map((asset) => asset.id),
      imagePurpose: galleryPhotoGuides.join(" | "),
      careerIndexes: [],
      layout: "gallery",
    });
  });
  pdfAssets.forEach((asset) => slides.push({
    type: "gallery",
    eyebrow: "DOCUMENTED ARCHIVE",
    title: `원문 자료로 확인하는 활동 기록${asset.pageNumber ? ` · ${asset.pageNumber}p` : ""}`,
    body: asset.sourceTitle ? compactText(asset.sourceTitle.replace(/^PDF \d+페이지\s*·?\s*/, ""), 42) : "선택한 PDF 원문 자료",
    bullets: [],
    imageRefs: [asset.id],
    imagePurpose: `선택한 PDF ${asset.pageNumber ?? ""}페이지 원문을 읽을 수 있는 크기로 배치`,
    careerIndexes: [],
    layout: "gallery",
  }));
  const careerIndexes = deckFacts.map((_, index) => index);
  for (let index = 0; index < Math.max(1, careerIndexes.length); index += 10) {
    slides.push({ type: "career", eyebrow: "SELECTED HISTORY", title: index ? "이어지는 주요 활동" : "경력으로 증명된 지속적인 활동", body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: careerIndexes.slice(index, index + 10), layout: "timeline" });
  }
  const contact: DeckSlidePlan = {
    type: "contact",
    eyebrow: "BOOKING & CONTACT",
    title: "공연·행사 섭외를 문의해 주세요",
    body: [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "),
    bullets: [profile.contact || "연락 가능한 전화번호 또는 이메일을 입력해 주세요", profile.videoUrl].filter(Boolean),
    imageRefs: [], imagePurpose: "", careerIndexes: [], layout: "editorial",
  };
  return { narrative: "정체성, 현장 이미지, 검증된 경력, 섭외 문의 순서로 빠르게 설득", visualDirection: "짧은 문구와 실제 공연 이미지 중심", slides: paginateSlideCopy([...slides, contact]).map(fitSlideCopy) };
}

function ensureAssetCoverage(plan: DeckPlan, assets: VisualAsset[]) {
  const usedIds = new Set(plan.slides.flatMap((slide) => slide.imageRefs));
  const missingPdfAssets = assets.filter((asset) => asset.kind === "pdf_page" && !usedIds.has(asset.id));
  const missingVisualAssets = assets.filter((asset) => asset.kind !== "pdf_page" && !usedIds.has(asset.id));
  const extraSlides: DeckSlidePlan[] = [];
  for (let index = 0; index < missingVisualAssets.length; index += 3) {
    const chunk = missingVisualAssets.slice(index, index + 3);
    extraSlides.push({ type: "gallery", eyebrow: "ADDITIONAL WORKS", title: "추가 활동 자료로 보는 현장", body: "", bullets: [], imageRefs: chunk.map((asset) => asset.id), imagePurpose: galleryPhotoGuides.join(" | "), careerIndexes: [], layout: "gallery" });
  }
  missingPdfAssets.forEach((asset) => extraSlides.push({ type: "gallery", eyebrow: "DOCUMENTED ARCHIVE", title: `원문 자료로 확인하는 활동 기록${asset.pageNumber ? ` · ${asset.pageNumber}p` : ""}`, body: asset.sourceTitle ? compactText(asset.sourceTitle.replace(/^PDF \d+페이지\s*·?\s*/, ""), 42) : "선택한 PDF 원문 자료", bullets: [], imageRefs: [asset.id], imagePurpose: `선택한 PDF ${asset.pageNumber ?? ""}페이지 원문을 읽을 수 있는 크기로 배치`, careerIndexes: [], layout: "gallery" }));
  if (!extraSlides.length) return plan;
  const contactIndex = plan.slides.findIndex((slide) => slide.type === "contact");
  const insertAt = contactIndex >= 0 ? contactIndex : plan.slides.length;
  return { ...plan, slides: [...plan.slides.slice(0, insertAt), ...extraSlides, ...plan.slides.slice(insertAt)] };
}

async function requestDeckPlan(profile: ProfileData, assets: VisualAsset[]) {
  const visualAssets = assets.filter((asset) => asset.kind !== "pdf_page");
  const pdfAssets = assets.filter((asset) => asset.kind === "pdf_page");
  const planningAssets = [...visualAssets.slice(0, 2), ...pdfAssets, ...visualAssets.slice(2)].slice(0, 24);
  const thumbnails = await Promise.all(planningAssets.map(async (asset) => ({ ...asset, dataUrl: await makeImageThumbnail(asset.dataUrl, asset.kind === "pdf_page" ? 520 : 640) })));
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
  const assets = collectDeckAssets(profile);
  try {
    const result = await requestDeckPlan(profile, assets);
    const coveredPlan = ensureAssetCoverage(result.plan, assets);
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
  const assets = collectDeckAssets(profile);
  const prepared = profile.deckPlan && profile.deckPlanMeta
    ? { plan: profile.deckPlan, meta: profile.deckPlanMeta }
    : await prepareDeckPlan(profile);
  const plan = { ...prepared.plan, slides: paginateSlideCopy(prepared.plan.slides).map(fitSlideCopy) };
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
    const sourceNotes = [...images.flatMap((asset) => asset.sourceUrl ? [`${asset.sourceTitle || "웹 이미지"}: ${asset.sourceUrl}`] : asset.kind === "generated" ? [asset.sourceTitle || "AI 연출 이미지 · 실제 현장 증빙이 아님"] : asset.kind === "pdf_page" ? [`사용자 제공 PDF ${asset.pageNumber ?? ""}페이지`] : []), ...factSourceNotes];
    if (sourceNotes.length) slide.addNotes(`[Sources]\n${sourceNotes.join("\n")}`);

    if (isCover) {
      if (primaryImage) {
        addImage(slide, primaryImage, 7.05, 0.45, 5.65, 6.6, slidePlan.imagePurpose, "contain");
      } else addImagePlaceholder(slide, 7.05, 0.45, 5.65, 6.6, slidePlan.imagePurpose || "얼굴이 선명한 세로 대표사진 · 반신 또는 전신");
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title || profile.artistName || "ARTIST", { x: 0.78, y: 2.1, w: 5.8, h: 1.35, fontSize: 52, bold: true, color: hex(p.text), margin: 0 });
      slide.addText(slidePlan.body || profile.tagline, { x: 0.82, y: 3.72, w: 5.65, h: 0.9, fontSize: 22, color: hex(p.muted), margin: 0 });
      slide.addText(`${profile.primaryField} · ${profile.region}`.replace(/^ · | · $/g, ""), { x: 0.82, y: 6.65, w: 6.0, h: 0.25, fontSize: 10, color: hex(p.muted), margin: 0 });
      return;
    }

    if (slidePlan.type === "gallery") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 11.8, h: 0.62, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
      const pdfAsset = images.length === 1 && images[0].kind === "pdf_page" ? images[0] : undefined;
      if (pdfAsset) {
        if (slidePlan.body) slide.addText(slidePlan.body, { x: 0.82, y: 1.73, w: 11.65, h: 0.3, fontSize: 11, color: hex(p.muted), margin: 0, breakLine: false });
        addImage(slide, pdfAsset, 0.78, 2.12, 11.78, 4.72, slidePlan.imagePurpose, "contain");
        addFooter(slide, slideIndex + 1);
        return;
      }
      const frames = [{ x: 0.78, y: 2.05, w: 7.2, h: 4.45 }, { x: 8.18, y: 2.05, w: 4.38, h: 2.1 }, { x: 8.18, y: 4.4, w: 4.38, h: 2.1 }];
      frames.forEach((frame, index) => {
        const asset = images[index];
        if (asset) addImage(slide, asset, frame.x, frame.y, frame.w, frame.h, galleryPhotoGuides[index], "contain");
        else addImagePlaceholder(slide, frame.x, frame.y, frame.w, frame.h, galleryPhotoGuides[index]);
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "career") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(slidePlan.title, { x: 0.78, y: 1.1, w: 11.7, h: 0.7, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
      const selected = (slidePlan.careerIndexes.length ? slidePlan.careerIndexes : deckFacts.map((_, index) => index)).map((index) => deckFacts[index]).filter(Boolean).slice(0, 10);
      const twoColumns = selected.length > 5;
      const perColumn = Math.ceil(selected.length / 2);
      const longestTitle = Math.max(0, ...selected.map((item) => formatCareerFact(item, twoColumns).title.length));
      const titleFontSize = twoColumns ? longestTitle > 24 || selected.length > 8 ? 11.5 : 13 : longestTitle > 34 ? 14 : 16;
      selected.forEach((item, index) => {
        const display = formatCareerFact(item, twoColumns);
        const column = twoColumns ? Math.floor(index / perColumn) : 0;
        const row = twoColumns ? index % perColumn : index;
        const x = twoColumns ? 0.82 + column * 6.15 : 0.82;
        const y = twoColumns ? 2.02 + row * 0.9 : 2.02 + row * 0.9;
        const dateWidth = twoColumns ? 0.72 : 1.25;
        const textX = x + (twoColumns ? 0.88 : 1.43);
        const textWidth = twoColumns ? 4.92 : 10.05;
        slide.addText(display.date, { x, y, w: dateWidth, h: 0.32, fontSize: twoColumns ? 11 : 16, bold: true, color: hex(p.accent), margin: 0 });
        slide.addText(display.title, { x: textX, y: y - 0.03, w: textWidth, h: 0.4, fontSize: titleFontSize, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
        if (display.meta) slide.addText(display.meta, { x: textX, y: y + 0.43, w: textWidth, h: 0.27, fontSize: twoColumns ? 9 : 12, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
        slide.addShape(pptx.ShapeType.line, { x: textX, y: y + 0.75, w: textWidth, h: 0, line: { color: hex(p.muted), transparency: 78, width: 0.6 } });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "contact") {
      addEyebrow(slide, "BOOKING & CONTACT");
      slide.addText(slidePlan.title || "공연·행사 섭외를 문의해 주세요", { x: 0.78, y: 1.35, w: 8.9, h: 1.15, fontSize: 42, bold: true, color: hex(p.text), margin: 0 });
      slide.addText(slidePlan.body || [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "), { x: 0.82, y: 2.85, w: 8.7, h: 0.5, fontSize: 17, color: hex(p.muted), margin: 0 });
      const contactText = profile.contact || slidePlan.bullets.find((item) => !/^https?:\/\//i.test(item)) || "연락 가능한 전화번호 또는 이메일을 입력해 주세요";
      const videoUrl = normalizeVideoUrl(profile.videoUrl || slidePlan.bullets.find((item) => /^https?:\/\//i.test(item)) || "");
      slide.addText("CONTACT", { x: 0.82, y: 4.05, w: 1.35, h: 0.25, fontSize: 9, bold: true, charSpacing: 1.5, color: hex(p.accent), margin: 0 });
      slide.addText(contactText, { x: 2.25, y: 3.94, w: 9.7, h: 0.45, fontSize: 19, bold: true, color: hex(p.text), margin: 0, breakLine: false });
      if (videoUrl) {
        const videoLabel = isYouTubeVideoUrl(videoUrl) ? "▶  YouTube 대표 영상 바로 보기" : "▶  대표 영상 바로 보기";
        slide.addText("VIDEO", { x: 0.82, y: 5.14, w: 1.35, h: 0.25, fontSize: 9, bold: true, charSpacing: 1.5, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.roundRect, { x: 2.25, y: 4.88, w: 4.25, h: 0.68, rectRadius: 0.08, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 }, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" } });
        slide.addText(videoLabel, { x: 2.55, y: 5.08, w: 3.72, h: 0.25, fontSize: 16, bold: true, color: "FFFFFF", margin: 0, align: "center", breakLine: false, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" } });
        slide.addText(compactText(videoUrl, 62), { x: 6.8, y: 5.05, w: 5.0, h: 0.28, fontSize: 11, color: hex(p.muted), margin: 0, breakLine: false, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" }, underline: { color: hex(p.muted) } });
      }
      slide.addText("일정과 행사 정보를 보내주시면 맞춤 구성으로 답변드리겠습니다.", { x: 0.82, y: 6.48, w: 9.2, h: 0.35, fontSize: 14, color: hex(p.muted), margin: 0 });
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
    const expectsImage = slidePlan.type === "about" && Boolean(slidePlan.imagePurpose);
    if (primaryImage) addImage(slide, primaryImage, imageOnLeft ? 0.42 : 7.55, 0.45, 5.35, 6.6, slidePlan.imagePurpose, "contain");
    else if (expectsImage) addImagePlaceholder(slide, imageOnLeft ? 0.42 : 7.55, 0.45, 5.35, 6.6, slidePlan.imagePurpose);
    const hasImageFrame = Boolean(primaryImage || expectsImage);
    const textX = hasImageFrame && imageOnLeft ? 6.55 : 0.78;
    const textW = hasImageFrame ? 5.9 : 11.7;
    slide.addText(slidePlan.eyebrow || "ARTIST PROFILE", { x: textX, y: 0.6, w: Math.min(4.8, textW), h: 0.28, fontSize: 10, bold: true, charSpacing: 2.5, color: hex(p.accent), margin: 0 });
    slide.addText(slidePlan.title, { x: textX, y: 1.35, w: textW, h: 1.3, fontSize: 35, bold: true, color: hex(p.text), margin: 0 });
    slide.addText(slidePlan.body || compactText(profile.introduction, 105), { x: textX, y: 3.1, w: hasImageFrame ? 5.55 : 8.8, h: 1.75, fontSize: 17, color: hex(p.muted), margin: 0, breakLine: false, paraSpaceAfter: 8 });
    if (slidePlan.bullets.length) slide.addText(slidePlan.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), { x: textX, y: 5.15, w: hasImageFrame ? 5.5 : 8.8, h: 1.15, fontSize: 15, color: hex(p.text), margin: 0, breakLine: false });
    addFooter(slide, slideIndex + 1);
  });

  await pptx.writeFile({ fileName: `${profile.artistName || "artist"}_profile.pptx` });
  return { ...exportMeta, slideCount: plan.slides.length };
}
