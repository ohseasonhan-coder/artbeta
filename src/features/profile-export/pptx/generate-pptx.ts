import { DeckPlan, DeckPlanMeta, DeckSlidePlan, ProfileData, ProfileVisualRole } from "@/types/profile";
import { getTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts, formatCareerFact, type DeckFact } from "./deck-facts";

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
  visualRole?: ProfileVisualRole;
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
    .forEach((dataUrl, index) => { if (dataUrl) { const category = profile.performanceImageCategories[index]; assets.push({ id: `performance-${index + 1}`, kind: "performance", origin: "upload", visualRole: category === "poster" ? "poster" : category === "history" ? "history" : "stage", visualType: category === "poster" || category === "history" ? "graphic" : "photo", dataUrl }); } });
  (profile.externalImages ?? []).filter((asset) => asset.source !== "ai" && asset.usageStatus === "approved").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "performance", origin: "web", visualRole: asset.visualRole, visualType: asset.visualRole === "poster" || asset.visualRole === "history" ? "graphic" : "photo", qualityScore: (asset.relevanceScore + asset.qualityScore + (asset.visualMatchScore ?? asset.relevanceScore)) / 3, dataUrl: asset.dataUrl, sourceUrl: asset.sourceUrl, sourceTitle: `${asset.source.toUpperCase()} · 동일 인물 일치 ${Math.round((asset.visualMatchScore ?? 0) * 100)} · ${asset.title}` }));
  (profile.externalImages ?? []).filter((asset) => asset.source === "ai" && asset.usageStatus === "approved").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "generated", origin: "ai", qualityScore: asset.qualityScore, dataUrl: asset.dataUrl, sourceTitle: `AI 연출 이미지 · ${asset.title}${asset.promptBasis ? ` · 근거: ${asset.promptBasis}` : ""}` }));
  profile.pdfPageAssets.filter((page) => page.selected).forEach((page) => page.extractedVisuals?.filter((visual) => visual.selected).forEach((visual) => assets.push({
    id: `pdf-visual-${page.pageNumber}-${visual.id}`,
    kind: "pdf_visual",
    origin: "pdf",
    visualType: visual.kind,
    visualRole: visual.role,
    qualityScore: ((visual.relevanceScore ?? 0.7) + (visual.qualityScore ?? 0.7)) / 2,
    pageNumber: page.pageNumber,
    dataUrl: visual.dataUrl,
    sourceTitle: `사용자 제공 PDF ${page.pageNumber}페이지 · ${visual.role === "portrait" ? "인물·대표사진" : visual.role === "stage" ? "무대·활동사진" : visual.role === "poster" ? "포스터·홍보물" : visual.role === "history" ? "연혁·수상자료" : visual.kind === "photo" ? "사진" : "그래픽"}`,
  })));
  return assets;
}

function visualAssetKey(asset: VisualAsset) {
  const source = asset.sourceUrl?.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase() || asset.origin;
  return `${source}:${asset.dataUrl.length}:${asset.dataUrl.slice(0, 120)}:${asset.dataUrl.slice(-120)}`;
}

export function selectPortfolioAssets(assets: VisualAsset[], limit = 8) {
  const uniqueAssets = assets.filter((asset, index, list) => list.findIndex((candidate) => visualAssetKey(candidate) === visualAssetKey(asset)) === index);
  const representative = uniqueAssets.find((asset) => asset.kind === "representative") || uniqueAssets.find((asset) => asset.visualRole === "portrait");
  const originScore = { upload: 92, web: 78, pdf: 96, ai: 55, representative: 100 } as const;
  const candidates = uniqueAssets.filter((asset) => asset !== representative).sort((a, b) => {
    const roleScore: Partial<Record<ProfileVisualRole, number>> = { portrait: 8, stage: 7, poster: 4, history: 3, other: 0, exclude: -100 };
    const score = (asset: VisualAsset) => originScore[asset.origin] + (asset.qualityScore ?? 0.7) * 12 + (asset.visualType === "photo" ? 3 : 0) + (roleScore[asset.visualRole || "other"] ?? 0);
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
  const words = text.split(" ");
  let result = "";
  for (const word of words) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > max - 1) break;
    result = next;
  }
  return result ? `${result.replace(/[.,·;:!?-]+$/, "").trim()}…` : words[0];
}

function splitText(value: string, max: number) {
  const remaining = value.replace(/\s+/g, " ").trim();
  if (!remaining || !max) return remaining ? [remaining] : [];
  const chunks: string[] = [];
  let current = "";
  remaining.split(" ").forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > max) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  });
  if (current) chunks.push(current);
  return chunks;
}

function wrapTextAtWords(value: string, maxCharsPerLine: number, maxLines: number) {
  const chunks = splitText(value, maxCharsPerLine);
  if (chunks.length <= maxLines) return chunks.join("\n");
  const visible = chunks.slice(0, maxLines);
  visible[maxLines - 1] = compactText(visible[maxLines - 1], Math.max(4, maxCharsPerLine - 1));
  return visible.join("\n");
}

function oneLineText(value: string, max: number) {
  return wrapTextAtWords(value, max, 1).replace(/\n/g, " ");
}

function clampPlanText(slide: DeckSlidePlan): DeckSlidePlan {
  const layout = {
    cover: { title: [14, 2], body: [23, 2] },
    about: { title: [20, 2], body: [32, 4] },
    strengths: { title: [26, 1], body: [0, 0] },
    gallery: { title: [15, 2], body: [22, 3] },
    career: { title: [26, 1], body: [0, 0] },
    contact: { title: [19, 2], body: [42, 1] },
  } as const;
  const budget = layout[slide.type];
  return {
    ...slide,
    title: wrapTextAtWords(slide.title, budget.title[0], budget.title[1]),
    body: budget.body[0] ? wrapTextAtWords(slide.body, budget.body[0], budget.body[1]) : "",
    bullets: slide.bullets.map((item) => wrapTextAtWords(item, slide.type === "strengths" ? 26 : 30, 2)),
  };
}

function enforceDeckSafety(plan: DeckPlan): DeckPlan {
  const usedImages = new Set<string>();
  const slides = plan.slides.map(clampPlanText).map((slide) => ({
    ...slide,
    imageRefs: slide.imageRefs.filter((id) => {
      if (usedImages.has(id)) return false;
      usedImages.add(id);
      return true;
    }).slice(0, 1),
    careerIndexes: [...new Set(slide.careerIndexes)].slice(0, 6),
  }));
  return { ...plan, slides };
}

function paginateSlideCopy(slides: DeckSlidePlan[]) {
  return slides;
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

function selectProposalFactIndexes(facts: ReturnType<typeof buildDeckFacts>, limit: number) {
  const categoryOrder = ["award", "performance", "career", "media"] as const;
  const byCategory = new Map(categoryOrder.map((category) => [category, [] as number[]]));
  facts.forEach((fact, index) => byCategory.get(fact.category)?.push(index));
  const yearOf = (index: number) => Number(facts[index].date.match(/(?:19|20)\d{2}/)?.[0] || 0);
  byCategory.forEach((indexes) => indexes.sort((left, right) => {
    const sourceScore = (index: number) => facts[index].source === "profile" ? 3 : facts[index].source === "pdf" ? 2 : 1;
    return sourceScore(right) - sourceScore(left) || yearOf(right) - yearOf(left) || left - right;
  }));
  const selected: number[] = [];
  while (selected.length < limit && categoryOrder.some((category) => (byCategory.get(category)?.length || 0) > 0)) {
    categoryOrder.forEach((category) => {
      const next = byCategory.get(category)?.shift();
      if (next !== undefined && selected.length < limit) selected.push(next);
    });
  }
  return selected;
}

function factLabel(fact?: DeckFact, max = 24) {
  if (!fact) return "";
  return compactText(formatCareerFact(fact, true).title, max);
}

function careerSlideTitle(facts: DeckFact[]) {
  const categories = new Set(facts.map((fact) => fact.category));
  if (categories.has("award") && categories.has("performance")) return "대표 무대와 공식 성과";
  if (categories.has("award")) return "수상 및 선정 이력";
  if (categories.has("performance")) return "대표 공연 및 활동";
  if (categories.has("media")) return "방송 및 언론 기록";
  return "주요 활동 이력";
}

function proposalBullets(profile: ProfileData) {
  const strength = (profile.generatedStrengths.length ? profile.generatedStrengths : profile.strengths)[0] || profile.tagline;
  return [
    `무대 구성 · ${[profile.primaryField, profile.secondaryField, profile.members].filter(Boolean).join(" · ")}`,
    strength ? `관객 경험 · ${strength}` : "",
    `제안 범위 · ${[profile.purpose, profile.region].filter(Boolean).join(" · ")}`,
  ].filter((item) => !item.endsWith("· ")).map((item) => compactText(item, 34)).slice(0, 3);
}

function fallbackPlan(profile: ProfileData, assets: VisualAsset[]): DeckPlan {
  const deckFacts = buildDeckFacts(profile);
  const proposalFactIndexes = selectProposalFactIndexes(deckFacts, profile.pageCount >= 8 ? 12 : 6);
  const evidenceAt = (index: number) => proposalFactIndexes.length ? [proposalFactIndexes[index % proposalFactIndexes.length]] : [];
  const evidenceFactAt = (index: number) => deckFacts[evidenceAt(index)[0]];
  const purposeTitle = compactText(`${profile.purpose || "행사"}에 맞춘 ${profile.primaryField || "문화예술"} 무대`, 32);
  const visualAssets = assets;
  const slides: DeckSlidePlan[] = [
    { type: "cover", eyebrow: "아티스트 섭외 제안", title: profile.artistName || "ARTIST", body: purposeTitle, bullets: [], imageRefs: visualAssets[0] ? [visualAssets[0].id] : [], imagePurpose: "얼굴과 분위기가 선명한 세로 대표사진 · 반신 또는 전신", careerIndexes: evidenceAt(0), layout: "split_right" },
    { type: "about", eyebrow: "아티스트 소개", title: compactText(profile.tagline || `${profile.primaryField}로 만드는 무대`, 32), body: compactText(profile.introduction, 105), bullets: [profile.primaryField, profile.region, profile.members].filter(Boolean).slice(0, 2), imageRefs: visualAssets[1] ? [visualAssets[1].id] : [], imagePurpose: "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장", careerIndexes: evidenceAt(1), layout: "split_right" },
    { type: "strengths", eyebrow: "제안 무대", title: purposeTitle, body: "", bullets: proposalBullets(profile), imageRefs: [], imagePurpose: "", careerIndexes: proposalFactIndexes.slice(0, 3), layout: "editorial" },
  ];
  const galleryAssets = visualAssets.slice(2, 4);
  galleryAssets.forEach((asset, index) => {
    slides.push({
      type: "gallery",
      eyebrow: "대표 활동",
      title: factLabel(evidenceFactAt(index + 2), 32) || (index ? "다양한 현장에서 이어온 활동" : "대표 무대에서 확인하는 아티스트의 색"),
      body: [evidenceFactAt(index + 2)?.date, evidenceFactAt(index + 2)?.organization].filter(Boolean).join(" · "),
      bullets: [],
      imageRefs: [asset.id],
      imagePurpose: index ? galleryPhotoGuides[1] : galleryPhotoGuides[0],
      careerIndexes: evidenceAt(index + 2),
      layout: "gallery",
    });
  });
  const careerPageCount = Math.max(1, Math.min(2, profile.pageCount - 4 - galleryAssets.length));
  const careerIndexes = proposalFactIndexes.slice(0, careerPageCount * 6);
  for (let index = 0; index < Math.max(1, careerIndexes.length); index += 6) {
    const pageIndexes = careerIndexes.slice(index, index + 6);
    slides.push({ type: "career", eyebrow: "주요 경력", title: careerSlideTitle(pageIndexes.map((factIndex) => deckFacts[factIndex]).filter(Boolean)), body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: pageIndexes, layout: "timeline" });
  }
  while (slides.length + 1 < profile.pageCount) {
    const factIndex = proposalFactIndexes[slides.length % Math.max(1, proposalFactIndexes.length)];
    const fact = deckFacts[factIndex];
    slides.push({
      type: "gallery",
      eyebrow: "활동 하이라이트",
      title: factLabel(fact, 32) || "아티스트의 주요 활동",
      body: fact?.organization ? compactText(`${fact.date} · ${fact.organization}`, 42) : "",
      bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: Number.isInteger(factIndex) ? [factIndex] : [], layout: "gallery",
    });
  }
  const contact: DeckSlidePlan = {
    type: "contact",
    eyebrow: "섭외 문의",
    title: "가능 일정과 출연 조건을 확인해 보세요",
    body: [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "),
    bullets: [profile.contact || "연락 가능한 전화번호 또는 이메일을 입력해 주세요", profile.videoUrl || profile.officialUrl].filter(Boolean),
    imageRefs: [], imagePurpose: "", careerIndexes: evidenceAt(4), layout: "editorial",
  };
  return enforceDeckSafety({ narrative: "고객이 얻을 현장 가치, 실제 장면, 검증된 경력, 섭외 행동 순서로 선택을 지원", visualDirection: "고객 관점의 짧은 결론과 출처가 분명한 실제 이미지 중심", slides: paginateSlideCopy([...slides, contact]).map(fitSlideCopy) });
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
    const asset = assets[nextAssetIndex];
    slide.imageRefs = asset ? [asset.id] : [];
    slide.imagePurpose ||= slide.type === "career" ? "해당 활동과 연결되는 현장 사진" : slide.type === "contact" ? "아티스트를 기억하게 만드는 마무리 사진" : "페이지 메시지를 뒷받침하는 활동 사진";
    slide.layout = index % 2 ? "split_right" : "split_left";
    if (asset) nextAssetIndex += 1;
  });
  return { ...plan, slides };
}

function ensureEvidenceCoverage(plan: DeckPlan, profile: ProfileData): DeckPlan {
  const facts = buildDeckFacts(profile);
  const indexes = selectProposalFactIndexes(facts, profile.pageCount >= 8 ? 12 : 6);
  if (!indexes.length) return plan;
  let cursor = 0;
  return {
    ...plan,
    slides: plan.slides.map((slide) => {
      if (slide.careerIndexes.length) return slide;
      const count = slide.type === "strengths" ? Math.min(3, indexes.length) : 1;
      const evidence = Array.from({ length: count }, () => indexes[cursor++ % indexes.length]);
      return { ...slide, careerIndexes: evidence };
    }),
  };
}

async function requestDeckPlan(profile: ProfileData, assets: VisualAsset[]) {
  const planningAssets = assets.slice(0, 24);
  const thumbnails = await Promise.all(planningAssets.map(async (asset) => ({ ...asset, dataUrl: await makeImageThumbnail(asset.dataUrl, 640) })));
  const deckFacts = buildDeckFacts(profile);
  const selectedFactIndexes = selectProposalFactIndexes(deckFacts, profile.pageCount >= 8 ? 12 : 6);
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
    careers: selectedFactIndexes.map((index) => ({ index, ...deckFacts[index] })),
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
  const assets = selectPortfolioAssets(collectDeckAssets(profile), 24);
  try {
    const result = await requestDeckPlan(profile, assets);
    const coveredPlan = ensureEvidenceCoverage(ensureVisualCoverage(result.plan, assets, profile), profile);
    return { plan: enforceDeckSafety({ ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides).map(fitSlideCopy) }), meta: { mode: "ai", provider: result.provider, model: result.model, qualityScore: result.qualityScore, coveredFactCount: result.coveredFactCount, totalFactCount: result.totalFactCount } };
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
  const assets = selectPortfolioAssets(collectDeckAssets(profile), 24);
  const prepared = profile.deckPlan && profile.deckPlanMeta
    ? { plan: profile.deckPlan, meta: profile.deckPlanMeta }
    : await prepareDeckPlan(profile);
  const coveredPlan = ensureEvidenceCoverage(ensureVisualCoverage(prepared.plan, assets, profile), profile);
  const plan = enforceDeckSafety({ ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides).map(fitSlideCopy) });
  const exportMeta = prepared.meta;
  const deckFacts = buildDeckFacts(profile);

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Artfolio Studio";
  pptx.subject = `${profile.artistName} 예술인 프로필`;
  pptx.title = `${profile.artistName || "예술인"} Profile`;
  pptx.company = "Artfolio";
  pptx.theme = { headFontFace: template.typography.heading, bodyFontFace: template.typography.body };

  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const pickImages = (slidePlan: DeckSlidePlan) => slidePlan.imageRefs
    .filter((id) => assetMap.has(id))
    .map((id) => assetMap.get(id)!);
  const addImage = (slide: ReturnType<typeof pptx.addSlide>, asset: VisualAsset, x: number, y: number, w: number, h: number, alt: string, mode: "contain" | "cover" = "contain") => {
    if (mode === "contain") slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: hex(p.surface) }, line: { color: hex(p.muted), transparency: 85, width: 0.5 } });
    slide.addImage({ data: asset.dataUrl, x, y, w, h, sizing: { type: mode, w, h }, altText: alt || `${profile.artistName} 활동 이미지` });
    if (asset.kind === "generated") slide.addText("AI 연출 이미지", { x: x + 0.12, y: y + h - 0.34, w: 1.18, h: 0.22, fontSize: 7, bold: true, color: "FFFFFF", fill: { color: "1B4D3E", transparency: 8 }, margin: 0.04, align: "center", breakLine: false });
  };
  const addFooter = (slide: ReturnType<typeof pptx.addSlide>, index: number) => {
    slide.addText(oneLineText(profile.artistName || "ARTIST", 24), { x: 10.2, y: 7.08, w: 1.75, h: 0.18, fontSize: 7, color: hex(p.muted), margin: 0, align: "right", fit: "shrink" });
    slide.addText(String(index).padStart(2, "0"), { x: 12.05, y: 7.05, w: 0.48, h: 0.2, fontSize: 8, bold: true, color: hex(p.accent), margin: 0, align: "right" });
  };
  const addEyebrow = (slide: ReturnType<typeof pptx.addSlide>, text: string, light = false, x = 0.78) => {
    slide.addText(oneLineText(text || "ARTIST PROFILE", 28), { x, y: 0.6, w: 4.8, h: 0.28, fontSize: 10, bold: true, charSpacing: 2.5, color: light ? "FFFFFF" : hex(p.accent), margin: 0, fit: "shrink" });
  };
  const addSystemMotif = (slide: ReturnType<typeof pptx.addSlide>) => {
    if (template.composition === "institutional") slide.addShape(pptx.ShapeType.line, { x: 0.78, y: 1.02, w: 11.75, h: 0, line: { color: hex(p.accent), width: 1.4 } });
    if (template.composition === "human") slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 } });
    if (template.composition === "dynamic") slide.addShape(pptx.ShapeType.rect, { x: 11.95, y: 0, w: 1.38, h: 0.28, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 } });
    if (template.composition === "heritage") slide.addShape(pptx.ShapeType.rect, { x: 0.38, y: 0.28, w: 12.57, h: 6.94, fill: { color: hex(p.background), transparency: 100 }, line: { color: hex(p.accent), transparency: 45, width: 0.7 } });
    if (template.composition === "gallery") slide.addShape(pptx.ShapeType.line, { x: 6.66, y: 0.42, w: 0, h: 6.65, line: { color: hex(p.muted), transparency: 62, width: 0.7 } });
    if (template.composition === "spotlight") slide.addShape(pptx.ShapeType.ellipse, { x: 11.45, y: -0.55, w: 2.4, h: 2.4, fill: { color: hex(p.accent), transparency: 54 }, line: { color: hex(p.accent), transparency: 100 } });
  };
  const addEvidence = (slide: ReturnType<typeof pptx.addSlide>, slidePlan: DeckSlidePlan, x = 0.82, w = 8.9) => {
    const fact = slidePlan.careerIndexes.map((index) => deckFacts[index]).find(Boolean);
    if (!fact) return;
    const evidence = formatCareerFact(fact, true);
    slide.addShape(pptx.ShapeType.line, { x, y: 6.55, w, h: 0, line: { color: hex(p.accent), transparency: 58, width: 0.8 } });
    slide.addText("주요 활동", { x, y: 6.63, w: 0.82, h: 0.2, fontSize: 8, bold: true, color: hex(p.accent), margin: 0 });
    slide.addText(oneLineText([evidence.date !== "—" ? evidence.date : "", evidence.title, evidence.meta].filter(Boolean).join(" · "), 72), { x: x + 0.98, y: 6.6, w: Math.max(1, w - 0.98), h: 0.27, fontSize: 9, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
  };

  plan.slides.forEach((slidePlan, slideIndex) => {
    const slide = pptx.addSlide();
    const images = pickImages(slidePlan);
    const primaryImage = images[0];
    const isCover = slidePlan.type === "cover";
    slide.background = { color: hex(isCover ? p.background : slideIndex % 2 ? p.surface : p.background) };
    addSystemMotif(slide);
    const factSourceNotes = slidePlan.careerIndexes.map((index) => deckFacts[index]).filter((fact) => fact?.sourceUrl).map((fact) => `${fact.sourceName || "웹 참고 출처"}: ${fact.sourceUrl}${fact.verificationTier === "reference" ? " (참고 자료 · 사실 확인 필요)" : ""}`);
    const sourceNotes = [...images.flatMap((asset) => asset.sourceUrl ? [`${asset.sourceTitle || "웹 이미지"}: ${asset.sourceUrl}`] : asset.kind === "generated" ? [asset.sourceTitle || "AI 연출 이미지 · 실제 현장 증빙이 아님"] : asset.kind === "pdf_visual" ? [asset.sourceTitle || `사용자 제공 PDF ${asset.pageNumber ?? ""}페이지에서 분리한 이미지`] : []), ...factSourceNotes];
    if (sourceNotes.length) slide.addNotes(`[Sources]\n${sourceNotes.join("\n")}`);

    if (isCover) {
      const imageOnLeft = template.coverImageSide === "left";
      const imageX = imageOnLeft ? 0.45 : 7.05;
      const copyX = primaryImage ? (imageOnLeft ? 6.75 : 0.78) : 0.82;
      const copyW = primaryImage ? 5.8 : 9.35;
      if (primaryImage) {
        addImage(slide, primaryImage, imageX, 0.45, 5.65, 6.6, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      } else {
        slide.addShape(pptx.ShapeType.rect, { x: 10.15, y: 0.45, w: 2.52, h: 6.35, fill: { color: hex(p.surface), transparency: 24 }, line: { color: hex(p.accent), transparency: 72, width: 0.7 } });
        slide.addText(profile.activeSince ? `SINCE\n${oneLineText(profile.activeSince, 10)}` : "ARTIST\nPROFILE", { x: 10.42, y: 1.15, w: 1.98, h: 1.25, fontSize: 25, bold: true, color: hex(p.text), transparency: 16, margin: 0, align: "center", breakLine: false, fit: "shrink" });
        slide.addText(oneLineText(profile.primaryField || "ARTIST", 18), { x: 10.42, y: 5.45, w: 1.98, h: 0.42, fontSize: 14, bold: true, color: hex(p.accent), margin: 0, align: "center", fit: "shrink" });
      }
      addEyebrow(slide, slidePlan.eyebrow, false, copyX);
      const coverTitle = wrapTextAtWords(slidePlan.title || profile.artistName || "ARTIST", 14, 2);
      const coverTitleLength = coverTitle.replace(/\s/g, "").length;
      const coverTitleFontSize = coverTitleLength > 20 ? 36 : coverTitleLength > 14 ? 42 : 50;
      slide.addText(coverTitle, { x: copyX, y: 1.55, w: copyW, h: 2.1, fontSize: primaryImage ? coverTitleFontSize : Math.min(54, coverTitleFontSize + 4), bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
      slide.addText(wrapTextAtWords(slidePlan.body || profile.tagline, primaryImage ? 23 : 34, 2), { x: copyX + 0.04, y: 4.05, w: primaryImage ? 5.65 : 8.2, h: 0.78, fontSize: 21, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
      slide.addShape(pptx.ShapeType.line, { x: copyX + 0.04, y: 5.55, w: primaryImage ? 1.1 : 1.65, h: 0, line: { color: hex(p.accent), width: 3 } });
      slide.addText(oneLineText(`${profile.primaryField} · ${profile.purpose} · ${profile.region}`.replace(/^ · | · $/g, ""), 52), { x: copyX + 0.04, y: 5.75, w: primaryImage ? 5.9 : 8.7, h: 0.28, fontSize: 11, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      addEvidence(slide, slidePlan, copyX + 0.04, primaryImage ? 5.9 : 8.85);
      return;
    }

    if (slidePlan.type === "gallery") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(wrapTextAtWords(slidePlan.title, 15, 2), { x: 0.78, y: 1.28, w: 4.05, h: 1.55, fontSize: 40, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
      if (slidePlan.body) slide.addText(wrapTextAtWords(slidePlan.body, 22, 3), { x: 0.82, y: 3.25, w: 3.85, h: 1.1, fontSize: 18, color: hex(p.muted), margin: 0, breakLine: false, valign: "middle", fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 5.15, 0.52, 7.45, 6.32, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      else {
        slide.addShape(pptx.ShapeType.rect, { x: 5.15, y: 0.52, w: 7.45, h: 6.32, fill: { color: hex(p.surface), transparency: 18 }, line: { color: hex(p.accent), transparency: 72, width: 0.7 } });
        const galleryFact = slidePlan.careerIndexes.map((index) => deckFacts[index]).find(Boolean);
        const galleryDisplay = galleryFact ? formatCareerFact(galleryFact, false) : null;
        slide.addText(galleryDisplay?.date || profile.activeSince || profile.primaryField || "ARTIST", { x: 5.62, y: 1.05, w: 5.95, h: 0.65, fontSize: 18, bold: true, color: hex(p.accent), margin: 0, fit: "shrink" });
        slide.addText(wrapTextAtWords(galleryFact?.organization || galleryFact?.categoryLabel || profile.primaryField || slidePlan.title, 18, 3), { x: 5.62, y: 2.0, w: 5.95, h: 2.5, fontSize: 38, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
        if (galleryDisplay?.title) slide.addText(oneLineText(galleryDisplay.title, 48), { x: 5.62, y: 5.25, w: 5.95, h: 0.35, fontSize: 12, color: hex(p.muted), margin: 0, fit: "shrink" });
      }
      addEvidence(slide, slidePlan, 0.82, 3.9);
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "career") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(oneLineText(slidePlan.title, 26), { x: 0.78, y: 1.1, w: primaryImage ? 7.25 : 11.35, h: 0.7, fontSize: 35, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      const selected = (slidePlan.careerIndexes.length ? slidePlan.careerIndexes : deckFacts.map((_, index) => index)).map((index) => deckFacts[index]).filter(Boolean).slice(0, 6);
      selected.forEach((item, index) => {
        const display = formatCareerFact(item, false);
        const columns = primaryImage || selected.length <= 3 ? 1 : 2;
        const rowsPerColumn = Math.ceil(selected.length / columns);
        const column = Math.floor(index / rowsPerColumn);
        const row = index % rowsPerColumn;
        const x = 0.82 + column * 6.05;
        const y = 2.1 + row * (columns === 2 ? 1.35 : 0.78);
        const titleW = primaryImage ? 6.25 : columns === 2 ? 4.55 : 10.35;
        slide.addShape(pptx.ShapeType.ellipse, { x, y: y + 0.08, w: 0.12, h: 0.12, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 } });
        slide.addText(oneLineText(display.date, 12), { x: x + 0.25, y, w: 0.85, h: 0.32, fontSize: 13, bold: true, color: hex(p.accent), margin: 0, fit: "shrink" });
        slide.addText(oneLineText(item.categoryLabel, 12), { x: x + 1.13, y: y + 0.02, w: 0.85, h: 0.22, fontSize: 8, bold: true, color: hex(p.muted), margin: 0, fit: "shrink" });
        slide.addText(oneLineText(display.title, columns === 2 ? 30 : 48), { x: x + 1.13, y: y + 0.31, w: titleW, h: 0.34, fontSize: columns === 2 ? 15 : 14, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
        if (display.meta) slide.addText(oneLineText(display.meta, 44), { x: x + 1.13, y: y + 0.7, w: titleW, h: 0.22, fontSize: 9, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
        slide.addShape(pptx.ShapeType.line, { x: x + 1.13, y: y + (columns === 2 ? 1.05 : 0.68), w: titleW, h: 0, line: { color: hex(p.muted), transparency: 80, width: 0.6 } });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "contact") {
      addEyebrow(slide, slidePlan.eyebrow || "섭외 문의");
      if (primaryImage) addImage(slide, primaryImage, 8.55, 0.65, 4.15, 6.25, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      const contactWidth = primaryImage ? 7.15 : 11.4;
      slide.addText(wrapTextAtWords(slidePlan.title || "가능 일정과 출연 조건을 확인해 보세요", primaryImage ? 19 : 28, 2), { x: 0.78, y: 1.35, w: contactWidth, h: 1.15, fontSize: primaryImage ? 42 : 46, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      slide.addText(oneLineText(slidePlan.body || [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "), 52), { x: 0.82, y: 2.85, w: contactWidth, h: 0.5, fontSize: 17, color: hex(p.muted), margin: 0, fit: "shrink" });
      const contactText = profile.contact || slidePlan.bullets.find((item) => !/^https?:\/\//i.test(item)) || "공식 채널을 통해 문의해 주세요";
      const videoUrl = normalizeVideoUrl(profile.videoUrl || profile.officialUrl || slidePlan.bullets.find((item) => /^https?:\/\//i.test(item)) || "");
      slide.addText("문의", { x: 0.82, y: 4.05, w: 1.35, h: 0.25, fontSize: 9, bold: true, charSpacing: 1.5, color: hex(p.accent), margin: 0 });
      slide.addText(oneLineText(contactText, primaryImage ? 42 : 64), { x: 2.25, y: 3.94, w: primaryImage ? 5.65 : 8.45, h: 0.45, fontSize: 19, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
      if (videoUrl) {
        const videoLabel = isYouTubeVideoUrl(videoUrl) ? "▶  YouTube 대표 영상 바로 보기" : "▶  대표 영상 바로 보기";
        slide.addText("대표 영상", { x: 0.82, y: 5.14, w: 1.35, h: 0.25, fontSize: 9, bold: true, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.roundRect, { x: 2.25, y: 4.88, w: 4.65, h: 0.68, rectRadius: 0.08, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 }, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" } });
        slide.addText(videoLabel, { x: 2.55, y: 5.08, w: 4.05, h: 0.25, fontSize: 16, bold: true, color: "FFFFFF", margin: 0, align: "center", breakLine: false, hyperlink: { url: videoUrl, tooltip: "대표 영상 열기" } });
      }
      slide.addText("행사 일정·장소·예상 관객을 알려주시면 적합한 구성과 출연 조건을 제안드립니다.", { x: 0.82, y: 6.18, w: 7.1, h: 0.3, fontSize: 13, color: hex(p.muted), margin: 0, fit: "shrink" });
      addEvidence(slide, slidePlan, 0.82, primaryImage ? 7.1 : 11.4);
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "strengths") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(oneLineText(slidePlan.title, 26), { x: 0.78, y: 1.1, w: primaryImage ? 7.2 : 11.4, h: 0.75, fontSize: 35, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      const bullets = slidePlan.bullets.length ? slidePlan.bullets : profile.generatedStrengths;
      bullets.slice(0, 3).forEach((item, index) => {
        const y = 2.35 + index * 1.35;
        slide.addText(`0${index + 1}`, { x: 0.82, y, w: 0.55, h: 0.35, fontSize: 15, bold: true, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.line, { x: 1.52, y: y + 0.16, w: 0.65, h: 0, line: { color: hex(p.accent), width: 1.2 } });
        slide.addText(wrapTextAtWords(item, primaryImage ? 26 : 42, 2), { x: 2.42, y: y - 0.12, w: primaryImage ? 5.55 : 8.6, h: 0.65, fontSize: primaryImage ? 21 : 23, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
        const proofFact = deckFacts[slidePlan.careerIndexes[index] ?? slidePlan.careerIndexes[0]];
        if (proofFact) {
          const proof = formatCareerFact(proofFact, true);
          slide.addText(oneLineText(`근거 ${proof.date !== "—" ? `${proof.date} · ` : ""}${proof.title}`, 54), { x: 2.42, y: y + 0.58, w: primaryImage ? 5.55 : 8.6, h: 0.24, fontSize: 9, bold: true, color: hex(p.accent), margin: 0, fit: "shrink" });
        }
      });
      addEvidence(slide, slidePlan, 0.82, primaryImage ? 7.1 : 11.4);
      addFooter(slide, slideIndex + 1);
      return;
    }

    const imageOnLeft = slidePlan.layout === "split_left" || (slidePlan.type === "about" && template.coverImageSide === "left");
    if (primaryImage) addImage(slide, primaryImage, imageOnLeft ? 0.42 : 7.55, 0.45, 5.35, 6.6, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
    const hasImageFrame = Boolean(primaryImage);
    const textX = hasImageFrame && imageOnLeft ? 6.55 : 0.78;
    const textW = hasImageFrame ? 5.9 : 11.7;
    slide.addText(oneLineText(slidePlan.eyebrow || "ARTIST PROFILE", 28), { x: textX, y: 0.6, w: Math.min(4.8, textW), h: 0.28, fontSize: 10, bold: true, charSpacing: 2.5, color: hex(p.accent), margin: 0, fit: "shrink" });
    slide.addText(wrapTextAtWords(slidePlan.title, 20, 2), { x: textX, y: 1.35, w: textW, h: 1.3, fontSize: 35, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
    slide.addText(wrapTextAtWords(slidePlan.body || compactText(profile.introduction, 105), 32, 4), { x: textX, y: 3.1, w: hasImageFrame ? 5.55 : 8.8, h: 1.75, fontSize: 17, color: hex(p.muted), margin: 0, breakLine: false, paraSpaceAfter: 8, fit: "shrink" });
    if (slidePlan.bullets.length) slide.addText(slidePlan.bullets.map((text) => ({ text: wrapTextAtWords(text, 30, 2), options: { bullet: { indent: 18 }, breakLine: true } })), { x: textX, y: 5.15, w: hasImageFrame ? 5.5 : 8.8, h: 1.15, fontSize: 16, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
    addEvidence(slide, slidePlan, textX, hasImageFrame ? 5.5 : 8.8);
    addFooter(slide, slideIndex + 1);
  });

  await pptx.writeFile({ fileName: `${profile.artistName || "artist"}_profile.pptx` });
  return { ...exportMeta, slideCount: plan.slides.length };
}
