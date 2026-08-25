import { DeckPlan, DeckPlanMeta, DeckQualityCheck, DeckSlidePlan, ProfileData, ProfileVisualRole } from "@/types/profile";
import { getTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts, formatCareerFact, rankDeckFactIndexes, type DeckFact } from "./deck-facts";
import { bookingConditionBullets, hasConfirmedBookingConditions } from "./booking-conditions";

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
  identityScore?: number;
  visualMatchScore?: number;
  pixelWidth?: number;
  pixelHeight?: number;
}

export interface DeckExportResult {
  mode: "ai" | "local";
  provider: string;
  model: string;
  slideCount: number;
  qualityScore?: number;
  qualityIssues?: string[];
}

export function collectDeckAssets(profile: ProfileData): VisualAsset[] {
  const assets: VisualAsset[] = [];
  if (profile.representativeImage) assets.push({ id: "representative", kind: "representative", origin: "representative", visualRole: "portrait", visualType: "photo", qualityScore: 1, dataUrl: profile.representativeImage });
  profile.performanceImages
    .forEach((dataUrl, index) => { if (dataUrl) { const category = profile.performanceImageCategories[index]; assets.push({ id: `performance-${index + 1}`, kind: "performance", origin: "upload", visualRole: category === "poster" ? "poster" : category === "history" ? "history" : "stage", visualType: category === "poster" || category === "history" ? "graphic" : "photo", dataUrl }); } });
  (profile.externalImages ?? []).filter((asset) => asset.source !== "ai"
    && asset.usageStatus === "approved"
    && !asset.watermarkDetected
    && (asset.identityScore ?? 0) >= 0.82
    && (asset.visualMatchScore ?? 0) >= 0.82
    && asset.relevanceScore >= 0.78
    && asset.qualityScore >= 0.72
    && asset.visualRole !== "exclude").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "performance", origin: "web", visualRole: asset.visualRole, visualType: asset.visualRole === "poster" || asset.visualRole === "history" ? "graphic" : "photo", qualityScore: (asset.relevanceScore + asset.qualityScore + (asset.visualMatchScore ?? asset.relevanceScore)) / 3, identityScore: asset.identityScore, visualMatchScore: asset.visualMatchScore, dataUrl: asset.dataUrl, sourceUrl: asset.sourceUrl, sourceTitle: `${asset.source.toUpperCase()} · 동일 인물 일치 ${Math.round((asset.visualMatchScore ?? 0) * 100)} · ${asset.title}` }));
  (profile.externalImages ?? []).filter((asset) => asset.source === "ai" && asset.usageStatus === "approved").forEach((asset) => assets.push({ id: `external-${asset.id}`, kind: "generated", origin: "ai", qualityScore: asset.qualityScore, dataUrl: asset.dataUrl, sourceTitle: `AI 연출 이미지 · ${asset.title}${asset.promptBasis ? ` · 근거: ${asset.promptBasis}` : ""}` }));
  profile.pdfPageAssets.filter((page) => page.selected).forEach((page) => page.extractedVisuals?.filter((visual) => {
    if (!visual.selected || visual.role === "exclude" || (visual.relevanceScore ?? 0.7) < 0.68 || (visual.qualityScore ?? 0.7) < 0.68) return false;
    const shortEdge = Math.min(visual.width, visual.height);
    const longEdge = Math.max(visual.width, visual.height);
    return visual.kind === "photo" ? shortEdge >= 420 && longEdge >= 720 : shortEdge >= 500 && longEdge >= 700;
  }).forEach((visual) => assets.push({
    id: `pdf-visual-${page.pageNumber}-${visual.id}`,
    kind: "pdf_visual",
    origin: "pdf",
    visualType: visual.kind,
    visualRole: visual.role,
    qualityScore: ((visual.relevanceScore ?? 0.7) + (visual.qualityScore ?? 0.7)) / 2,
    pixelWidth: visual.width,
    pixelHeight: visual.height,
    pageNumber: page.pageNumber,
    dataUrl: visual.dataUrl,
    sourceTitle: `사용자 제공 PDF ${page.pageNumber}페이지 · ${visual.role === "portrait" ? "인물·대표사진" : visual.role === "stage" ? "무대·활동사진" : visual.role === "poster" ? "포스터·홍보물" : visual.role === "history" ? "연혁·수상자료" : visual.kind === "photo" ? "사진" : "그래픽"}`,
  })));
  return assets;
}

async function hydrateVisualDimensions(assets: VisualAsset[]) {
  if (typeof Image === "undefined") return assets;
  await Promise.all(assets.map((asset) => new Promise<void>((resolve) => {
    if (asset.pixelWidth && asset.pixelHeight) return resolve();
    const image = new Image();
    const finish = () => resolve();
    image.onload = () => {
      asset.pixelWidth = image.naturalWidth;
      asset.pixelHeight = image.naturalHeight;
      finish();
    };
    image.onerror = finish;
    image.src = asset.dataUrl;
  })));
  return assets;
}

function hasPresentationResolution(asset: VisualAsset) {
  const width = asset.pixelWidth ?? 0;
  const height = asset.pixelHeight ?? 0;
  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);
  if (!width || !height) return asset.origin === "representative" || asset.origin === "upload";
  if (asset.origin === "representative") return shortEdge >= 360 && longEdge >= 600;
  if (asset.visualType === "graphic") return shortEdge >= 500 && longEdge >= 700;
  if (asset.origin === "pdf") return shortEdge >= 420 && longEdge >= 720 && (asset.qualityScore ?? 0) >= 0.7;
  if (asset.origin === "web") return shortEdge >= 480 && longEdge >= 720 && (asset.visualMatchScore ?? 0) >= 0.82;
  return shortEdge >= 480 && longEdge >= 720;
}

export async function prepareVisualAssets(profile: ProfileData) {
  const hydrated = await hydrateVisualDimensions(collectDeckAssets(profile));
  return selectPortfolioAssets(hydrated.filter(hasPresentationResolution), 24);
}

function canUseAsBackground(asset: VisualAsset, type: DeckSlidePlan["type"]) {
  if (!["cover", "gallery"].includes(type) || asset.visualType !== "photo") return false;
  if (!["stage", "other"].includes(asset.visualRole || "other")) return false;
  const width = asset.pixelWidth ?? 0;
  const height = asset.pixelHeight ?? 0;
  const ratio = height ? width / height : 0;
  const quality = asset.qualityScore ?? (asset.origin === "upload" ? 0.9 : 0.7);
  const requiredQuality = asset.origin === "pdf" || asset.origin === "ai" ? 0.84 : 0.78;
  return width >= 1600 && height >= 900 && width * height >= 1_400_000 && ratio >= 1.45 && ratio <= 2.2 && quality >= requiredQuality;
}

function visualAssetKey(asset: VisualAsset) {
  const payload = asset.dataUrl.replace(/^data:[^,]+,/, "");
  const stride = Math.max(1, Math.floor(payload.length / 96));
  let signature = "";
  for (let index = 0; index < payload.length && signature.length < 96; index += stride) signature += payload[index];
  return `${payload.length}:${signature}`;
}

export function selectPortfolioAssets(assets: VisualAsset[], limit = 8) {
  const uniqueAssets = assets.filter((asset, index, list) => asset.visualRole !== "exclude" && list.findIndex((candidate) => visualAssetKey(candidate) === visualAssetKey(asset)) === index);
  const representative = uniqueAssets.find((asset) => asset.kind === "representative") || uniqueAssets.find((asset) => asset.visualRole === "portrait");
  const originScore = { upload: 96, web: 92, pdf: 70, ai: 52, representative: 100 } as const;
  const candidates = uniqueAssets.filter((asset) => asset !== representative).sort((a, b) => {
    const roleScore: Partial<Record<ProfileVisualRole, number>> = { portrait: 8, stage: 7, poster: 4, history: 3, other: 0, exclude: -100 };
    const score = (asset: VisualAsset) => originScore[asset.origin] + (asset.qualityScore ?? 0.7) * 28 + (asset.visualType === "photo" ? 4 : 0) + (roleScore[asset.visualRole || "other"] ?? 0);
    return score(b) - score(a);
  });
  const selected = representative ? [representative] : [];
  const roleCaps: Partial<Record<ProfileVisualRole, number>> = { portrait: 2, poster: 2, history: 2 };
  candidates.forEach((asset) => {
    if (selected.length >= limit) return;
    const role = asset.visualRole || "other";
    const cap = roleCaps[role];
    if (cap && selected.filter((item) => (item.visualRole || "other") === role).length >= cap) return;
    selected.push(asset);
  });
  candidates.forEach((asset) => { if (selected.length < limit && !selected.includes(asset)) selected.push(asset); });
  return selected.slice(0, limit);
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
  if (chunks.length <= maxLines) {
    for (let pass = 0; pass < maxLines * 2; pass += 1) {
      let changed = false;
      for (let index = chunks.length - 1; index > 0; index -= 1) {
        if (chunks[index].length >= maxCharsPerLine * 0.48) continue;
        const previousWords = chunks[index - 1].split(" ");
        if (previousWords.length < 2) continue;
        const movedWord = previousWords.at(-1)!;
        const nextLine = `${movedWord} ${chunks[index]}`;
        if (nextLine.length > maxCharsPerLine) continue;
        chunks[index - 1] = previousWords.slice(0, -1).join(" ");
        chunks[index] = nextLine;
        changed = true;
      }
      if (!changed) break;
    }
    return chunks.join("\n");
  }
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
    bullets: slide.bullets.map((item) => wrapTextAtWords(item, slide.type === "strengths" ? 26 : slide.type === "about" ? 38 : 30, slide.type === "about" ? 1 : 2)),
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

function normalizeNarrativeStructure(plan: DeckPlan, profile: ProfileData): DeckPlan {
  const first = plan.slides.find((slide) => slide.type === "cover");
  const lastCandidate = [...plan.slides].reverse().find((slide) => slide.type === "contact");
  const last = lastCandidate ? {
    ...lastCandidate,
    title: /문의|일정|출연|조건/.test(lastCandidate.title) ? lastCandidate.title : "가능 일정과 출연 조건을 확인해 보세요",
  } : undefined;
  const about = plan.slides.find((slide) => slide.type === "about" && (slide.title.trim() || slide.body.trim()));
  const strengths = plan.slides.find((slide) => slide.type === "strengths");
  const careerLimit = profile.pageCount >= 12 ? 5 : profile.pageCount >= 10 ? 4 : 2;
  const careers = plan.slides.filter((slide) => slide.type === "career" && slide.careerIndexes.length).slice(0, careerLimit);
  const galleryLimit = Math.min(5, Math.max(0, profile.pageCount - 4 - careers.length));
  const galleries = plan.slides.filter((slide) => slide.type === "gallery" && slide.imageRefs.length && (slide.title.trim() || slide.careerIndexes.length)).slice(0, galleryLimit);
  const slides = [first, about, strengths, ...galleries, ...careers, last].filter((slide): slide is DeckSlidePlan => Boolean(slide));
  return { ...plan, narrative: "정체성 → 제안 가치와 조건 → 실제 장면 → 목적에 맞는 공식 근거 → 문의", slides };
}

function auditDeckQuality(plan: DeckPlan, profile: ProfileData, assets: VisualAsset[]) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const imageIds = plan.slides.flatMap((slide) => slide.imageRefs);
  const facts = buildDeckFacts(profile);
  const validFactIndexes = new Set(facts.map((_, index) => index));
  const budgets = {
    cover: [26, 42, 0, 0], about: [32, 105, 3, 38], strengths: [32, 0, 3, 48],
    gallery: [32, 42, 0, 0], career: [32, 0, 0, 0], contact: [30, 60, 2, 48],
  } as const;
  const roleFit = (slide: DeckSlidePlan) => slide.imageRefs.every((id) => {
    const role = assetMap.get(id)?.visualRole || "other";
    if (slide.type === "cover") return ["portrait", "stage", "other"].includes(role);
    if (slide.type === "gallery") return ["stage", "other"].includes(role) && assetMap.get(id)?.visualType !== "graphic";
    if (slide.type === "career") return ["history", "poster", "stage", "other"].includes(role);
    return role !== "exclude";
  });
  const checks: DeckQualityCheck[] = [
    { id: "structure", label: "설득 흐름", passed: plan.slides[0]?.type === "cover" && plan.slides.at(-1)?.type === "contact", detail: "표지에서 섭외 문의까지 한 방향으로 구성" },
    { id: "purpose", label: "페이지별 단일 목적", passed: ["cover", "about", "strengths", "contact"].every((type) => plan.slides.filter((slide) => slide.type === type).length <= 1), detail: "소개·제안·근거·문의 역할 중복 방지" },
    { id: "text", label: "텍스트 안전 영역", passed: plan.slides.every((slide) => { const budget = budgets[slide.type]; return slide.title.replace(/\n/g, " ").length <= budget[0] && (!budget[1] || slide.body.replace(/\n/g, " ").length <= budget[1]) && slide.bullets.length <= budget[2] && slide.bullets.every((item) => item.replace(/\n/g, " ").length <= budget[3]); }), detail: "제목·본문·목록의 절대 글자 수 제한" },
    { id: "word_wrap", label: "단어 단위 줄바꿈", passed: plan.slides.every((slide) => !/[가-힣A-Za-z0-9]-\n[가-힣A-Za-z0-9]/.test(`${slide.title}\n${slide.body}\n${slide.bullets.join("\n")}`)), detail: "단어 중간 분리와 강제 하이픈 줄바꿈 금지" },
    { id: "images", label: "이미지 중복 방지", passed: new Set(imageIds).size === imageIds.length, detail: "동일 자산은 전체 PPT에서 한 번만 사용" },
    { id: "image_quality", label: "최종 이미지 품질", passed: imageIds.every((id) => { const asset = assetMap.get(id); return Boolean(asset && hasPresentationResolution(asset)); }), detail: "중간 해상도는 작은 프레임, 고해상도 가로 사진만 배경으로 사용" },
    { id: "image_identity", label: "웹 이미지 인물 일치", passed: imageIds.every((id) => { const asset = assetMap.get(id); return !asset || asset.origin !== "web" || ((asset.identityScore ?? 0) >= 0.82 && (asset.visualMatchScore ?? 0) >= 0.82); }), detail: "동일 인물 근거가 강한 승인 웹 이미지만 사용" },
    { id: "background_quality", label: "배경 이미지 적합성", passed: plan.slides.every((slide) => slide.layout !== "full_bleed" || slide.imageRefs.every((id) => { const asset = assetMap.get(id); return Boolean(asset && canUseAsBackground(asset, slide.type)); })), detail: "고해상도 가로 활동사진만 배경으로 사용" },
    { id: "image_role", label: "페이지-이미지 역할 일치", passed: plan.slides.every(roleFit), detail: "대표·활동·포스터·수상자료를 목적에 맞게 배정" },
    { id: "empty_gallery", label: "빈 이미지 페이지 방지", passed: plan.slides.every((slide) => slide.type !== "gallery" || slide.imageRefs.length === 1), detail: "사진이 없는 갤러리 페이지는 자동 제외" },
    { id: "evidence", label: "경력 근거 연결", passed: !facts.length || plan.slides.filter((slide) => ["strengths", "career"].includes(slide.type)).every((slide) => slide.careerIndexes.some((index) => validFactIndexes.has(index))), detail: "제안 가치와 경력 페이지를 실제 경력에 연결" },
    { id: "gallery_alignment", label: "사진과 경력 일치", passed: plan.slides.filter((slide) => slide.type === "gallery").every((slide) => slide.imageRefs.every((id) => { const asset = assetMap.get(id); if (!asset?.pageNumber || !slide.careerIndexes.length) return true; return slide.careerIndexes.some((index) => facts[index]?.pageNumber === asset.pageNumber); })), detail: "PDF 사진은 같은 원문 페이지의 경력과만 연결" },
    { id: "gallery_photo", label: "대표 장면 사진 품질", passed: plan.slides.filter((slide) => slide.type === "gallery").every((slide) => slide.imageRefs.every((id) => assetMap.get(id)?.visualType === "photo")), detail: "문서 전체 캡처·연혁표·포스터를 대표 활동사진처럼 확대하지 않음" },
    { id: "gallery_titles", label: "반복 문구 방지", passed: (() => { const titles = plan.slides.filter((slide) => slide.type === "gallery").map((slide) => slide.title.replace(/\s+/g, " ").trim()); return new Set(titles).size === titles.length; })(), detail: "연속된 대표 장면마다 서로 다른 메시지 사용" },
    { id: "contact", label: "섭외 행동 유도", passed: /문의|일정|출연|조건/.test(plan.slides.at(-1)?.title || ""), detail: profile.contact.trim() ? "실제 연락처 포함" : "연락처가 없어 공식 문의 문구로 대체" },
    { id: "gallery_copy", label: "대표 장면 제목 정제", passed: plan.slides.filter((slide) => slide.type === "gallery").every((slide) => !/정리\s*사진|스크린샷|캡처|IMG[_-]?\d|DSC[_-]?\d|\.jpe?g|\.png/i.test(`${slide.title} ${slide.body}`)), detail: "파일명·사진 정리 문구·OCR 조각을 고객용 제목으로 사용하지 않음" },
    { id: "final_copy", label: "내부 제작 문구 제거", passed: plan.slides.every((slide) => !/PHOTO\s*BRIEF|VERIFIED|이미지\s*(준비|삽입|교체)|사실\s*확인\s*필요|입력해\s*주세요/i.test(`${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`)), detail: "고객에게 전달할 최종 문장만 표시" },
    { id: "source_markers", label: "내부 출처 표기 제거", passed: !/(?:^|\s)(?:원문\s*)?\d+\s*(?:p|페이지|슬라이드)(?:\s|$)/i.test(plan.slides.map((slide) => `${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`).join("\n")), detail: "2p·페이지·슬라이드 같은 분석용 표기는 노트에만 보관" },
  ];
  const score = Math.round(checks.filter((check) => check.passed).length / checks.length * 100);
  return { score, checks, issues: checks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.detail}`) };
}

function paginateSlideCopy(slides: DeckSlidePlan[]) {
  return slides;
}

function fitSlideCopy(slide: DeckSlidePlan): DeckSlidePlan {
  const budgets = {
    cover: [26, 42, 0, 0], about: [32, 105, 3, 38], strengths: [32, 0, 3, 48],
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

function selectProposalFactIndexes(facts: ReturnType<typeof buildDeckFacts>, limit: number, purpose = "") {
  return rankDeckFactIndexes(facts, purpose, limit);
}

function factLimitForPageCount(pageCount: number) {
  return pageCount >= 12 ? 24 : pageCount >= 10 ? 18 : pageCount >= 8 ? 14 : 10;
}

function factLabel(fact?: DeckFact, max = 24) {
  if (!fact) return "";
  return compactText(formatCareerFact(fact, true).title, max);
}

function galleryFactCopy(fact?: DeckFact) {
  if (!fact) return { title: "현장에서 확인하는 대표 활동", body: "" };
  const label = factLabel(fact, 26);
  const title = fact.category === "award"
    ? "공식 수상으로 확인된 활동 성과"
    : fact.category === "media"
      ? "방송과 음원으로 이어진 대외 활동"
      : /공연|무대|콘서트|축제|페스티벌/.test(label) && !/사진|캡처|스크린샷/.test(label)
        ? label
        : /촬영|뮤직비디오|앨범|싱글/.test(label)
          ? "콘텐츠로 확장한 대표 활동"
          : "현장에서 확인하는 대표 활동";
  return { title, body: compactText([label, fact.date, fact.organization].filter(Boolean).join(" · "), 42) };
}

function careerSlideTitle(facts: DeckFact[]) {
  const categories = new Set(facts.map((fact) => fact.category));
  if (categories.has("award") && categories.has("performance")) return "대표 무대와 공식 성과";
  if (categories.has("award")) return "수상 및 선정 이력";
  if (categories.has("performance")) return "대표 공연 및 활동";
  if (categories.has("media")) return "방송 및 언론 기록";
  return "주요 활동 이력";
}

function distinctCareerSlideTitle(baseTitle: string, occurrence: number) {
  if (!occurrence) return baseTitle;
  const alternatives: Record<string, string[]> = {
    "대표 무대와 공식 성과": ["무대 경험을 뒷받침하는 성과", "공연과 수상으로 확인한 활동 범위"],
    "수상 및 선정 이력": ["공식 성과와 대외 인정", "주요 수상으로 확인한 경쟁력"],
    "대표 공연 및 활동": ["축제·공연장 주요 활동", "현장에서 쌓아 온 무대 경험"],
    "방송 및 언론 기록": ["미디어 출연과 대외 활동", "방송 기록으로 보는 활동 범위"],
    "주요 활동 이력": ["협업 범위를 보여주는 주요 경력", "지속적인 활동과 프로젝트 경험"],
  };
  return alternatives[baseTitle]?.[(occurrence - 1) % alternatives[baseTitle].length] || baseTitle;
}

function paginateCareerFactIndexes(indexes: number[], facts: DeckFact[], pageCount: number) {
  const categoryOrder = [...new Set(indexes.map((index) => facts[index]?.category).filter(Boolean))];
  const groups = categoryOrder.map((category) => indexes.filter((index) => facts[index]?.category === category));
  const pages: number[][] = [];
  groups.forEach((group) => {
    if (pages.length < pageCount && group.length) pages.push(group.splice(0, 5));
  });
  const leftovers = groups.flat();
  while (leftovers.length && pages.length < pageCount) pages.push(leftovers.splice(0, 5));
  leftovers.forEach((factIndex) => {
    const target = pages.find((page) => page.length < 5);
    if (target) target.push(factIndex);
  });
  return pages.slice(0, pageCount);
}

function proposalBullets(profile: ProfileData) {
  const confirmedConditions = bookingConditionBullets(profile);
  if (confirmedConditions.length) return confirmedConditions;
  const extractedValues = (type: "repertoire" | "program_configuration") => profile.extractedItems
    .filter((item) => item.type === type && item.status !== "excluded")
    .map((item) => item.value.trim())
    .filter(Boolean);
  const configurations = extractedValues("program_configuration");
  const repertoire = extractedValues("repertoire");
  const strength = (profile.generatedStrengths.length ? profile.generatedStrengths : profile.strengths)[0] || profile.tagline;
  const proposal = [
    `무대 구성 · ${configurations[0] || [profile.primaryField, profile.secondaryField].filter(Boolean).join(" · ")}`,
    repertoire.length ? `대표 레퍼토리 · ${repertoire.slice(0, 2).join(" · ")}` : strength ? `관객 경험 · ${strength}` : "",
    `제안 범위 · ${[profile.purpose, profile.region].filter(Boolean).join(" · ")}`,
  ].filter((item) => !item.endsWith("· "));
  return proposal.map((item) => compactText(item, 48)).slice(0, 3);
}

function aboutProofBullets(profile: ProfileData) {
  const facts = buildDeckFacts(profile);
  return rankDeckFactIndexes(facts, profile.purpose, 3).map((index) => {
    const display = formatCareerFact(facts[index], true);
    return compactText([display.date !== "—" ? display.date : "", display.title].filter(Boolean).join(" · "), 38);
  });
}

function synchronizeProposalSlide(plan: DeckPlan, profile: ProfileData): DeckPlan {
  const bookingMode = hasConfirmedBookingConditions(profile);
  const facts = buildDeckFacts(profile);
  return {
    ...plan,
    slides: plan.slides.map((slide) => {
      if (slide.type === "strengths") return {
        ...slide,
        eyebrow: bookingMode ? "섭외 조건" : "제안 무대",
        title: bookingMode ? "확인된 섭외 조건 요약" : compactText(`${profile.purpose || "행사"}에 맞춘 ${profile.primaryField || "문화예술"} 무대`, 32),
        body: "",
        bullets: proposalBullets(profile),
      };
      if (slide.type === "about") return { ...slide, bullets: aboutProofBullets(profile) };
      if (slide.type === "gallery") {
        const copy = galleryFactCopy(slide.careerIndexes.map((index) => facts[index]).find(Boolean));
        return { ...slide, title: copy.title, body: copy.body };
      }
      if (slide.type === "contact") return { ...slide, bullets: [profile.contact, profile.videoUrl || profile.officialUrl].filter(Boolean) };
      return slide;
    }),
  };
}

function fallbackPlan(profile: ProfileData, assets: VisualAsset[]): DeckPlan {
  const deckFacts = buildDeckFacts(profile);
  const proposalFactIndexes = selectProposalFactIndexes(deckFacts, factLimitForPageCount(profile.pageCount), profile.purpose);
  const evidenceAt = (index: number) => proposalFactIndexes.length ? [proposalFactIndexes[index % proposalFactIndexes.length]] : [];
  const evidenceFactAt = (index: number) => deckFacts[evidenceAt(index)[0]];
  const purposeTitle = compactText(`${profile.purpose || "행사"}에 맞춘 ${profile.primaryField || "문화예술"} 무대`, 32);
  const visualAssets = assets;
  const slides: DeckSlidePlan[] = [
    { type: "cover", eyebrow: "아티스트 섭외 제안", title: profile.artistName || "ARTIST", body: purposeTitle, bullets: [], imageRefs: visualAssets[0] ? [visualAssets[0].id] : [], imagePurpose: "얼굴과 분위기가 선명한 세로 대표사진 · 반신 또는 전신", careerIndexes: evidenceAt(0), layout: "split_right" },
    { type: "about", eyebrow: "아티스트 소개", title: compactText(profile.tagline || `${profile.primaryField}로 만드는 무대`, 32), body: compactText(profile.introduction, 105), bullets: aboutProofBullets(profile), imageRefs: visualAssets[1] ? [visualAssets[1].id] : [], imagePurpose: "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장", careerIndexes: evidenceAt(1), layout: "split_right" },
    { type: "strengths", eyebrow: hasConfirmedBookingConditions(profile) ? "섭외 조건" : "제안 무대", title: hasConfirmedBookingConditions(profile) ? "확인된 섭외 조건 요약" : purposeTitle, body: "", bullets: proposalBullets(profile), imageRefs: [], imagePurpose: "", careerIndexes: proposalFactIndexes.slice(0, 3), layout: "editorial" },
  ];
  const desiredCareerPageCount = Math.max(1, Math.min(profile.pageCount >= 12 ? 5 : profile.pageCount >= 10 ? 4 : 2, Math.ceil(proposalFactIndexes.length / 5)));
  const galleryAssets = visualAssets.slice(2, 2 + Math.min(5, Math.max(0, profile.pageCount - 4 - desiredCareerPageCount)));
  galleryAssets.forEach((asset, index) => {
    const galleryCopy = galleryFactCopy(evidenceFactAt(index + 2));
    slides.push({
      type: "gallery",
      eyebrow: "대표 활동",
      title: galleryCopy.title,
      body: galleryCopy.body,
      bullets: [],
      imageRefs: [asset.id],
      imagePurpose: index ? galleryPhotoGuides[1] : galleryPhotoGuides[0],
      careerIndexes: evidenceAt(index + 2),
      layout: "gallery",
    });
  });
  const careerPageCount = Math.max(1, Math.min(desiredCareerPageCount, profile.pageCount - 4 - galleryAssets.length));
  const careerPages = paginateCareerFactIndexes(proposalFactIndexes, deckFacts, careerPageCount);
  const careerTitleCounts = new Map<string, number>();
  for (const pageIndexes of careerPages) {
    const baseTitle = careerSlideTitle(pageIndexes.map((factIndex) => deckFacts[factIndex]).filter(Boolean));
    const occurrence = careerTitleCounts.get(baseTitle) || 0;
    careerTitleCounts.set(baseTitle, occurrence + 1);
    slides.push({ type: "career", eyebrow: "주요 경력", title: distinctCareerSlideTitle(baseTitle, occurrence), body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: pageIndexes, layout: "timeline" });
  }
  while (slides.length + 1 < profile.pageCount) {
    const factIndex = proposalFactIndexes[slides.length % Math.max(1, proposalFactIndexes.length)];
    const fact = deckFacts[factIndex];
    const galleryCopy = galleryFactCopy(fact);
    slides.push({
      type: "gallery",
      eyebrow: "활동 하이라이트",
      title: galleryCopy.title,
      body: galleryCopy.body,
      bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: Number.isInteger(factIndex) ? [factIndex] : [], layout: "gallery",
    });
  }
  const contact: DeckSlidePlan = {
    type: "contact",
    eyebrow: "섭외 문의",
    title: "가능 일정과 출연 조건을 확인해 보세요",
    body: [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "),
    bullets: [profile.contact, profile.videoUrl || profile.officialUrl].filter(Boolean),
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
  const available = [...assets];
  const preferredRoles: Record<DeckSlidePlan["type"], ProfileVisualRole[]> = {
    cover: ["portrait", "stage", "other"],
    about: ["stage", "portrait", "other"],
    strengths: ["stage", "other", "portrait"],
    gallery: ["stage", "poster", "other"],
    career: ["history", "poster", "stage", "other"],
    contact: ["portrait", "stage", "other"],
  };
  const takeAsset = (type: DeckSlidePlan["type"]) => {
    for (const role of preferredRoles[type]) {
      const index = available.findIndex((asset) => (asset.visualRole || "other") === role);
      if (index >= 0) return available.splice(index, 1)[0];
    }
    return undefined;
  };
  const coverAsset = takeAsset("cover");
  if (coverAsset) {
    slides[normalizedCoverIndex].imageRefs = [coverAsset.id];
    if (canUseAsBackground(coverAsset, "cover")) slides[normalizedCoverIndex].layout = "full_bleed";
  }

  let primaryAboutIndex = -1;
  if (available.length) {
    let aboutIndex = slides.findIndex((slide) => slide.type === "about");
    if (aboutIndex < 0) {
      slides.splice(normalizedCoverIndex + 1, 0, { type: "about", eyebrow: "ARTIST IDENTITY", title: profile.tagline || `${profile.primaryField}로 만드는 무대`, body: profile.introduction, bullets: aboutProofBullets(profile), imageRefs: [], imagePurpose: "대표 활동사진", careerIndexes: [], layout: "split_right" });
      aboutIndex = normalizedCoverIndex + 1;
    }
    const aboutAsset = takeAsset("about");
    if (aboutAsset) slides[aboutIndex].imageRefs = [aboutAsset.id];
    primaryAboutIndex = aboutIndex;
  }

  const careerSlideCount = slides.filter((slide) => slide.type === "career" && slide.careerIndexes.length).length;
  const desiredGalleryCount = Math.min(5, Math.max(0, profile.pageCount - 4 - careerSlideCount));
  const requiredGalleryAssets = available.filter((asset) => asset.visualRole === "stage" && asset.visualType !== "graphic").slice(0, desiredGalleryCount);
  const requiredGalleryIds = new Set(requiredGalleryAssets.map((asset) => asset.id));
  for (let index = available.length - 1; index >= 0; index -= 1) {
    if (requiredGalleryIds.has(available[index].id)) available.splice(index, 1);
  }
  const reservedGalleryAssets = [...requiredGalleryAssets];
  let galleryIndexes = slides.map((slide, index) => slide.type === "gallery" ? index : -1).filter((index) => index >= 0);
  while (galleryIndexes.length < requiredGalleryAssets.length) {
    const insertAt = slides.findIndex((slide) => slide.type === "career" || slide.type === "contact");
    slides.splice(insertAt >= 0 ? insertAt : slides.length, 0, { type: "gallery", eyebrow: "SIGNATURE MOMENT", title: galleryIndexes.length ? "또 하나의 대표 장면" : "이 무대를 기억하게 만드는 순간", body: "", bullets: [], imageRefs: [], imagePurpose: "대표 활동을 보여주는 강한 사진 한 장", careerIndexes: [], layout: "gallery" });
    galleryIndexes = slides.map((slide, index) => slide.type === "gallery" ? index : -1).filter((index) => index >= 0);
  }
  const allowedGalleryIndexes = new Set(galleryIndexes.slice(0, requiredGalleryAssets.length));
  slides = slides.filter((slide, index) => slide.type !== "gallery" || allowedGalleryIndexes.has(index));
  galleryIndexes = slides.map((slide, index) => slide.type === "gallery" ? index : -1).filter((index) => index >= 0);
  let stageGalleryCount = 0;
  const deckFacts = buildDeckFacts(profile);
  const normalizedTokenSet = (value: string) => new Set(value.toLowerCase().replace(/[^0-9a-z가-힣\s]/g, " ").split(/\s+/).filter((token) => token.length >= 2));
  const matchingFactIndexes = (asset: VisualAsset) => deckFacts.map((fact, factIndex) => {
    let score = 0;
    if (asset.pageNumber && fact.pageNumber === asset.pageNumber) score += 100;
    if (asset.sourceUrl && fact.sourceUrl && asset.sourceUrl === fact.sourceUrl) score += 90;
    const assetTokens = normalizedTokenSet(asset.sourceTitle || "");
    const factTokens = normalizedTokenSet(`${fact.title} ${fact.organization}`);
    score += [...assetTokens].filter((token) => factTokens.has(token)).length * 12;
    return { factIndex, score };
  }).filter((candidate) => candidate.score >= 24).sort((left, right) => right.score - left.score).slice(0, 1).map(({ factIndex }) => factIndex);
  slides.forEach((slide, index) => {
    if (slide.type === "cover" || index === primaryAboutIndex) return;
    const asset = slide.type === "gallery" ? reservedGalleryAssets.shift() : takeAsset(slide.type);
    slide.imageRefs = asset ? [asset.id] : [];
    if (slide.type === "gallery") slide.careerIndexes = asset ? matchingFactIndexes(asset) : [];
    slide.imagePurpose ||= slide.type === "career" ? "해당 활동과 연결되는 현장 사진" : slide.type === "contact" ? "아티스트를 기억하게 만드는 마무리 사진" : "페이지 메시지를 뒷받침하는 활동 사진";
    if (slide.type === "gallery" && asset?.visualRole === "poster") {
      slide.eyebrow = "공연 레퍼런스";
      slide.title = "대표 출연작과 공연 활동";
      slide.body = "실제 출연작과 공연 포스터를 한눈에 확인합니다.";
    } else if (slide.type === "gallery" && asset?.visualRole === "history") {
      slide.eyebrow = "활동 증빙";
      slide.title = "공연 기록으로 보는 활동 범위";
      slide.body = "수상·공연·방송 기록을 한눈에 확인합니다.";
    } else if (slide.type === "gallery" && asset?.visualRole === "stage") {
      const stageTitles = ["대표 무대에서 확인한 공연 역량", "행사 규모에 맞춘 현장 구성", "관객과 호흡하는 대표 장면"];
      const stageBodies = ["공연 전경과 출연 구성을 한눈에 확인합니다.", "행사 성격과 관객층에 맞춰 무대를 구성합니다.", "실제 현장의 분위기와 관객 접점을 보여줍니다."];
      const fact = slide.careerIndexes.map((factIndex) => deckFacts[factIndex]).find(Boolean);
      const display = fact ? formatCareerFact(fact, true) : undefined;
      slide.eyebrow = "대표 무대";
      slide.title = stageTitles[stageGalleryCount % stageTitles.length];
      slide.body = display
        ? compactText([display.date !== "—" ? display.date : "", display.title, display.meta].filter(Boolean).join(" · "), 42)
        : stageBodies[stageGalleryCount % stageBodies.length];
      stageGalleryCount += 1;
    }
    slide.layout = asset && canUseAsBackground(asset, slide.type) ? "full_bleed" : index % 2 ? "split_right" : "split_left";
  });
  return { ...plan, slides };
}

function ensureEvidenceCoverage(plan: DeckPlan, profile: ProfileData): DeckPlan {
  const facts = buildDeckFacts(profile);
  const indexes = selectProposalFactIndexes(facts, factLimitForPageCount(profile.pageCount), profile.purpose);
  if (!indexes.length) return plan;
  let cursor = 0;
  return {
    ...plan,
    slides: plan.slides.map((slide) => {
      if (["cover", "about", "contact"].includes(slide.type)) return { ...slide, careerIndexes: [] };
      if (slide.type === "gallery") return slide;
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
  const selectedFactIndexes = selectProposalFactIndexes(deckFacts, factLimitForPageCount(profile.pageCount), profile.purpose);
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
    performanceDuration: profile.performanceDuration,
    castSize: profile.castSize,
    technicalRequirements: profile.technicalRequirements,
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
  const assets = await prepareVisualAssets(profile);
  try {
    const result = await requestDeckPlan(profile, assets);
    const coveredPlan = ensureEvidenceCoverage(ensureVisualCoverage(synchronizeProposalSlide(result.plan, profile), assets, profile), profile);
    const safePlan = enforceDeckSafety({ ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides).map(fitSlideCopy) });
    const finalPlan = normalizeNarrativeStructure(safePlan, profile);
    const quality = auditDeckQuality(finalPlan, profile, assets);
    return { plan: finalPlan, meta: { mode: "ai", provider: result.provider, model: result.model, qualityScore: quality.score, coveredFactCount: result.coveredFactCount, totalFactCount: result.totalFactCount, qualityChecks: quality.checks, qualityIssues: quality.issues } };
  } catch (error) {
    const failure = error as Error & { code?: string };
    const coveredLocalPlan = ensureEvidenceCoverage(ensureVisualCoverage(synchronizeProposalSlide(fallbackPlan(profile, assets), profile), assets, profile), profile);
    const localPlan = normalizeNarrativeStructure(enforceDeckSafety({ ...coveredLocalPlan, slides: paginateSlideCopy(coveredLocalPlan.slides).map(fitSlideCopy) }), profile);
    const quality = auditDeckQuality(localPlan, profile, assets);
    return {
      plan: localPlan,
      meta: {
        mode: "local",
        provider: "기본 기획",
        model: "로컬",
        warning: failure.message || "Gemini PPT 기획을 완료하지 못했습니다.",
        errorCode: failure.code || "DECK_PLANNING_FAILED",
        qualityScore: quality.score,
        qualityChecks: quality.checks,
        qualityIssues: quality.issues,
      },
    };
  }
}

export async function downloadPptx(profile: ProfileData): Promise<DeckExportResult> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const template = getTemplate(profile.templateKey);
  const p = template.palette;
  const assets = await prepareVisualAssets(profile);
  const minimumUsefulSlides = Math.max(8, profile.pageCount - 1);
  const prepared = profile.deckPlan && profile.deckPlanMeta && profile.deckPlan.slides.length >= minimumUsefulSlides
    ? { plan: profile.deckPlan, meta: profile.deckPlanMeta }
    : await prepareDeckPlan(profile);
  const coveredPlan = ensureEvidenceCoverage(ensureVisualCoverage(synchronizeProposalSlide(prepared.plan, profile), assets, profile), profile);
  const plan = normalizeNarrativeStructure(enforceDeckSafety({ ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides).map(fitSlideCopy) }), profile);
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
    const backgroundImage = primaryImage && slidePlan.layout === "full_bleed" && canUseAsBackground(primaryImage, slidePlan.type) ? primaryImage : undefined;
    slide.background = { color: hex(isCover ? p.background : slideIndex % 2 ? p.surface : p.background) };
    if (backgroundImage) {
      addImage(slide, backgroundImage, 0, 0, 13.333, 7.5, slidePlan.imagePurpose, "cover");
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 7.5, fill: { color: "07101F", transparency: 50 }, line: { color: "07101F", transparency: 100 } });
      slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 7.15, h: 7.5, fill: { color: "07101F", transparency: 22 }, line: { color: "07101F", transparency: 100 } });
      if (backgroundImage.kind === "generated") slide.addText("AI 연출 이미지", { x: 11.55, y: 7.05, w: 1.1, h: 0.2, fontSize: 7, bold: true, color: "FFFFFF", margin: 0, align: "right" });
    }
    addSystemMotif(slide);
    const factSourceNotes = slidePlan.careerIndexes.map((index) => deckFacts[index]).filter((fact) => fact?.sourceUrl).map((fact) => `${fact.sourceName || "웹 참고 출처"}: ${fact.sourceUrl}${fact.verificationTier === "reference" ? " (참고 자료 · 사실 확인 필요)" : ""}`);
    const conditionSourceNotes = slidePlan.type === "strengths" ? profile.extractedItems
      .filter((item) => ["performance_duration", "cast_size", "technical_requirement"].includes(item.type) && item.status !== "excluded")
      .map((item) => `${item.label}: ${item.value}${item.pageNumber ? ` · 원문 ${item.pageNumber}p` : ""}${item.sourceUrl ? ` · ${item.sourceUrl}` : ""}`) : [];
    const sourceNotes = [...images.flatMap((asset) => asset.sourceUrl ? [`${asset.sourceTitle || "웹 이미지"}: ${asset.sourceUrl}`] : asset.kind === "generated" ? [asset.sourceTitle || "AI 연출 이미지 · 실제 현장 증빙이 아님"] : asset.kind === "pdf_visual" ? [asset.sourceTitle || `사용자 제공 PDF ${asset.pageNumber ?? ""}페이지에서 분리한 이미지`] : []), ...factSourceNotes, ...conditionSourceNotes];
    if (sourceNotes.length) slide.addNotes(`[Sources]\n${sourceNotes.join("\n")}`);

    if (isCover && backgroundImage) {
      addEyebrow(slide, slidePlan.eyebrow, true);
      const coverTitle = wrapTextAtWords(slidePlan.title || profile.artistName || "ARTIST", 14, 2);
      slide.addText(coverTitle, { x: 0.78, y: 1.5, w: 6.15, h: 2.05, fontSize: coverTitle.replace(/\s/g, "").length > 18 ? 44 : 54, bold: true, color: "FFFFFF", margin: 0, valign: "middle", fit: "shrink" });
      slide.addText(wrapTextAtWords(slidePlan.body || profile.tagline, 24, 2), { x: 0.82, y: 4.02, w: 5.95, h: 0.82, fontSize: 22, color: "FFFFFF", transparency: 10, margin: 0, fit: "shrink" });
      slide.addShape(pptx.ShapeType.line, { x: 0.82, y: 5.48, w: 1.25, h: 0, line: { color: hex(p.accent), width: 3 } });
      slide.addText(oneLineText(`${profile.primaryField} · ${profile.purpose} · ${profile.region}`.replace(/^ · | · $/g, ""), 52), { x: 0.82, y: 5.68, w: 6, h: 0.3, fontSize: 11, bold: true, color: "FFFFFF", margin: 0, fit: "shrink" });
      return;
    }

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
      return;
    }

    if (slidePlan.type === "gallery" && backgroundImage) {
      addEyebrow(slide, slidePlan.eyebrow, true);
      slide.addText(wrapTextAtWords(slidePlan.title, 15, 2), { x: 0.78, y: 1.3, w: 5.7, h: 1.7, fontSize: 44, bold: true, color: "FFFFFF", margin: 0, valign: "middle", fit: "shrink" });
      if (slidePlan.body) slide.addText(wrapTextAtWords(slidePlan.body, 27, 3), { x: 0.82, y: 3.42, w: 5.45, h: 1.15, fontSize: 19, color: "FFFFFF", transparency: 10, margin: 0, valign: "middle", fit: "shrink" });
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
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "career") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(wrapTextAtWords(slidePlan.title, primaryImage ? 17 : 25, 2), { x: 0.78, y: 1.16, w: primaryImage ? 7.25 : 11.35, h: 0.82, fontSize: primaryImage ? 35 : 38, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      const selected = (slidePlan.careerIndexes.length ? slidePlan.careerIndexes : deckFacts.map((_, index) => index)).map((index) => deckFacts[index]).filter(Boolean).slice(0, 6);
      selected.forEach((item, index) => {
        const display = formatCareerFact(item, false);
        const columns = primaryImage || selected.length <= 3 ? 1 : 2;
        const rowsPerColumn = Math.ceil(selected.length / columns);
        const column = Math.floor(index / rowsPerColumn);
        const row = index % rowsPerColumn;
        const x = 0.82 + column * 6.05;
        const rowStep = primaryImage ? 0.88 : columns === 2 ? 1.35 : 1.25;
        const y = 2.2 + row * rowStep;
        const hasDate = display.date !== "—";
        const contentX = x + (hasDate ? 1.13 : 0.25);
        const titleW = primaryImage ? (hasDate ? 6.25 : 7.13) : columns === 2 ? (hasDate ? 4.55 : 5.43) : (hasDate ? 10.35 : 11.23);
        slide.addShape(pptx.ShapeType.ellipse, { x, y: y + 0.08, w: 0.12, h: 0.12, fill: { color: hex(p.accent) }, line: { color: hex(p.accent), transparency: 100 } });
        if (hasDate) slide.addText(oneLineText(display.date, 12), { x: x + 0.25, y, w: 0.85, h: 0.32, fontSize: 14, bold: true, color: hex(p.accent), margin: 0, fit: "shrink" });
        slide.addText(oneLineText(item.categoryLabel, 12), { x: contentX, y: y + 0.02, w: 1.05, h: 0.22, fontSize: 10, bold: true, color: hex(p.muted), margin: 0, fit: "shrink" });
        slide.addText(oneLineText(display.title, columns === 2 ? 30 : 48), { x: contentX, y: y + 0.28, w: titleW, h: 0.34, fontSize: columns === 1 && !primaryImage ? 18 : 16, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
        if (display.meta) slide.addText(oneLineText(display.meta, 44), { x: contentX, y: y + 0.61, w: titleW, h: 0.21, fontSize: columns === 1 && !primaryImage ? 12 : 11, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
        slide.addShape(pptx.ShapeType.line, { x: contentX, y: y + rowStep - 0.08, w: titleW, h: 0, line: { color: hex(p.muted), transparency: 80, width: 0.6 } });
      });
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "contact") {
      addEyebrow(slide, slidePlan.eyebrow || "섭외 문의");
      if (primaryImage) addImage(slide, primaryImage, 8.55, 0.65, 4.15, 6.25, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      const contactWidth = primaryImage ? 7.15 : 11.4;
      slide.addText(wrapTextAtWords(slidePlan.title || "가능 일정과 출연 조건을 확인해 보세요", primaryImage ? 18 : 26, 2), { x: 0.78, y: 1.25, w: contactWidth, h: 1.38, fontSize: primaryImage ? 39 : 44, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
      slide.addText(oneLineText(slidePlan.body || [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "), 52), { x: 0.82, y: 2.85, w: contactWidth, h: 0.5, fontSize: 17, color: hex(p.muted), margin: 0, fit: "shrink" });
      const contactText = profile.contact || slidePlan.bullets.find((item) => !/^https?:\/\//i.test(item)) || "출연 일정 및 조건 문의";
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
      addFooter(slide, slideIndex + 1);
      return;
    }

    if (slidePlan.type === "strengths") {
      addEyebrow(slide, slidePlan.eyebrow);
      slide.addText(wrapTextAtWords(slidePlan.title, primaryImage ? 17 : 26, 2), { x: 0.78, y: 1.16, w: primaryImage ? 7.2 : 11.4, h: 1.04, fontSize: primaryImage ? 35 : 38, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
      if (primaryImage) addImage(slide, primaryImage, 8.55, 1.05, 4.15, 5.85, slidePlan.imagePurpose, primaryImage.visualType === "graphic" ? "contain" : "cover");
      const bullets = slidePlan.bullets.length ? slidePlan.bullets : profile.generatedStrengths;
      bullets.slice(0, 3).forEach((item, index) => {
        const y = 2.48 + index * 1.25;
        slide.addText(`0${index + 1}`, { x: 0.82, y, w: 0.55, h: 0.35, fontSize: 15, bold: true, color: hex(p.accent), margin: 0 });
        slide.addShape(pptx.ShapeType.line, { x: 1.52, y: y + 0.16, w: 0.65, h: 0, line: { color: hex(p.accent), width: 1.2 } });
        slide.addText(wrapTextAtWords(item, primaryImage ? 24 : 40, 2), { x: 2.42, y: y - 0.15, w: primaryImage ? 5.55 : 8.6, h: 0.78, fontSize: primaryImage ? 19 : 22, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
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
    slide.addText(wrapTextAtWords(slidePlan.title, hasImageFrame ? 12 : 20, hasImageFrame ? 2 : 3), { x: textX, y: 1.3, w: textW, h: 1.5, fontSize: hasImageFrame ? 35 : 38, bold: true, color: hex(p.text), margin: 0, valign: "middle", fit: "shrink" });
    slide.addText(wrapTextAtWords(slidePlan.body || compactText(profile.introduction, 105), 32, 4), { x: textX, y: 3.1, w: hasImageFrame ? 5.55 : 8.8, h: 1.75, fontSize: 17, color: hex(p.muted), margin: 0, breakLine: false, paraSpaceAfter: 8, fit: "shrink" });
    if (slidePlan.bullets.length) slide.addText(slidePlan.bullets.map((text) => ({ text: oneLineText(text, 38), options: { bullet: { indent: 18 }, breakLine: true } })), { x: textX, y: 5.05, w: hasImageFrame ? 5.5 : 8.8, h: 1.28, fontSize: 16, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
    addFooter(slide, slideIndex + 1);
  });

  const safeArtistName = (profile.artistName || "artist")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[.\s]+$/g, "")
    .trim()
    .slice(0, 80) || "artist";
  const fileName = `${safeArtistName}_profile.pptx`;
  if (typeof document !== "undefined") {
    const output = await pptx.write({ outputType: "blob" });
    const blob = output instanceof Blob ? output : new Blob([output as BlobPart], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } else {
    await pptx.writeFile({ fileName });
  }
  const quality = auditDeckQuality(plan, profile, assets);
  return { ...exportMeta, qualityScore: quality.score, qualityIssues: quality.issues, slideCount: plan.slides.length };
}
