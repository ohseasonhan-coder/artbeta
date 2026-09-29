import { DeckPlan, DeckPlanMeta, DeckQualityCheck, DeckQualityDimensionId, DeckQualityMetric, DeckSlidePlan, ProfileData, ProfileVisualRole } from "@/types/profile";
import { getTemplate } from "@/features/design-templates/registry/templates";
import { buildDeckFacts, formatCareerFact, rankDeckFactIndexes, type DeckFact } from "./deck-facts";
import { hasConfirmedBookingConditions } from "./booking-conditions";
import { CAREER_PHOTO_CAPACITY } from "./career-layout";
import { buildDecisionHookBullets, buildDecisionHookTitle, hasStrongDecisionHooks } from "./decision-hooks";
import { renderDeckQaFrames } from "./deck-visual-qa";
import { compactKoreanText, koreanTextWidth, normalizeKoreanDisplayText } from "./korean-typesetting";

import { buildSlideScene, inspectSlideScene, SLIDE_LAYOUT_VERSION } from "./slide-scene";

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
  promptVersion?: string;
  slideCount: number;
  qualityScore?: number;
  qualityIssues?: string[];
  visualQualityScore?: number;
  visualReviewIterations?: number;
  qualityMetrics?: DeckQualityMetric[];
  releaseReady?: boolean;
}

interface DeckVisualReviewResult {
  overallScore: number;
  deckIssues: string[];
  dimensionScores: Record<DeckQualityDimensionId, number>;
  slides: Array<{
    slideIndex: number;
    score: number;
    verdict: "pass" | "revise";
    issues: string[];
    rationale: string;
    revision?: { title: string; body: string; bullets: string[]; layout: DeckSlidePlan["layout"] };
  }>;
  provider: string;
  model: string;
  reviewVersion: string;
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
    const timeout = window.setTimeout(() => { asset.dataUrl = ""; resolve(); }, 12000);
    const finish = () => { window.clearTimeout(timeout); resolve(); };
    image.onload = () => {
      asset.pixelWidth = image.naturalWidth;
      asset.pixelHeight = image.naturalHeight;
      finish();
    };
    image.onerror = () => { asset.dataUrl = ""; finish(); };
    image.src = asset.dataUrl;
  })));
  return assets;
}

function hasPresentationResolution(asset: VisualAsset) {
  if (!asset.dataUrl) return false;
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
  return max ? compactKoreanText(value, max) : "";
}

function enforceDeckSafety(plan: DeckPlan): DeckPlan {
  const usedImages = new Set<string>();
  const slides = plan.slides.map((slide) => ({
    ...slide,
    imageRefs: slide.imageRefs.filter((id) => {
      if (usedImages.has(id)) return false;
      usedImages.add(id);
      return true;
    }).slice(0, 1),
    careerIndexes: [...new Set(slide.careerIndexes)].slice(0, slide.type === "career" ? 6 : slide.type === "strengths" ? 3 : slide.type === "gallery" ? 1 : 0),
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
  const program = plan.slides.find((slide) => slide.type === "program" && slide.bullets.length);
  const team = plan.slides.find((slide) => slide.type === "team" && slide.bullets.length);
  const careers = plan.slides.filter((slide) => slide.type === "career" && slide.careerIndexes.length);
  const offerSlideCount = Number(Boolean(program)) + Number(Boolean(team));
  const galleryLimit = Math.min(5, Math.max(0, profile.pageCount - 4 - offerSlideCount - careers.length));
  const galleries = plan.slides.filter((slide) => slide.type === "gallery" && slide.imageRefs.length && (slide.title.trim() || slide.careerIndexes.length)).slice(0, galleryLimit);
  const slides = [first, about, strengths, program, team, ...galleries, ...careers, last].filter((slide): slide is DeckSlidePlan => Boolean(slide));
  return { ...plan, narrative: "정체성 → 제안 가치와 조건 → 선택 가능한 프로그램과 팀 구성 → 실제 장면 → 공식 근거 → 문의", slides };
}

function auditDeckQuality(plan: DeckPlan, profile: ProfileData, assets: VisualAsset[]) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const sceneIssues = plan.slides.flatMap((slide, index) => inspectSlideScene(buildSlideScene(slide, index, profile, getTemplate(profile.templateKey), assetMap)).map(issue => `${index + 1}페이지: ${issue}`));
  const imageIds = plan.slides.flatMap((slide) => slide.imageRefs);
  const facts = buildDeckFacts(profile);
  const validFactIndexes = new Set(facts.map((_, index) => index));
  const budgets = {
    cover: [26, 42, 0, 0], about: [32, 105, 3, 38], strengths: [32, 0, 3, 48], program: [32, 46, 6, 36], team: [32, 46, 4, 42],
    gallery: [32, 42, 0, 0], career: [32, 0, 0, 0], contact: [30, 60, 2, 48],
  } as const;
  const roleFit = (slide: DeckSlidePlan) => slide.imageRefs.every((id) => {
    const role = assetMap.get(id)?.visualRole || "other";
    if (slide.type === "cover") return ["portrait", "stage", "other"].includes(role);
    if (slide.type === "gallery") return ["stage", "other"].includes(role) && assetMap.get(id)?.visualType !== "graphic";
    if (slide.type === "career") return ["history", "poster", "stage", "other"].includes(role);
    return role !== "exclude";
  });
  const lineLimits = {
    cover: [2, 2], about: [2, 4], strengths: [2, 0], program: [2, 2], team: [2, 2], gallery: [2, 3], career: [2, 0], contact: [2, 1],
  } as const;
  const hasSafeKoreanLines = (slide: DeckSlidePlan) => {
    const [titleLines, bodyLines] = lineLimits[slide.type];
    const blocks = [[slide.title, titleLines], [slide.body, bodyLines], ...slide.bullets.map((bullet) => [bullet, 2] as const)] as const;
    return blocks.every(([value, maxLines]) => {
      if (!value) return true;
      const lines = value.split("\n");
      return lines.length <= maxLines && lines.every((line) => line.length > 0 && !/^[,.;:!?·|｜)\]}]/.test(line) && !/[([{·|｜]$/.test(line));
    });
  };
  const decisionSlide = plan.slides.find((slide) => slide.type === "strengths");
  const decisionHooksReady = Boolean(decisionSlide && hasStrongDecisionHooks(decisionSlide.title, decisionSlide.bullets, facts.length > 0));
  const takeawayTitlesReady = plan.slides.filter((slide) => !["cover", "career"].includes(slide.type)).every((slide) => slide.title.trim().length >= 8 && !/^(주요 활동|대표 활동|아티스트 소개|대표 사진|프로필|공연 프로그램|출연 구성)$/i.test(slide.title.trim()));
  const checks: DeckQualityCheck[] = [
    { id: "scene_fit", label: "실제 배치 검증", passed: sceneIssues.length === 0, detail: sceneIssues.join(" · ") || "사진·문구 겹침, 영역 이탈, 문구 잘림 없음" },
    { id: "structure", label: "설득 흐름", passed: plan.slides[0]?.type === "cover" && plan.slides.at(-1)?.type === "contact", detail: "표지에서 섭외 문의까지 한 방향으로 구성" },
    { id: "purpose", label: "페이지별 단일 목적", passed: ["cover", "about", "strengths", "program", "team", "contact"].every((type) => plan.slides.filter((slide) => slide.type === type).length <= 1), detail: "소개·제안·프로그램·팀 구성·근거·문의 역할 중복 방지" },
    { id: "offer_completeness", label: "섭외 선택지 반영", passed: (!profile.extractedItems.some((item) => item.type === "repertoire" && item.status !== "excluded") || plan.slides.some((slide) => slide.type === "program")) && (!profile.extractedItems.some((item) => item.type === "program_configuration" && item.status !== "excluded") || plan.slides.some((slide) => slide.type === "team")), detail: "PDF에서 확인된 레퍼토리와 팀 구성을 독립 페이지로 제시" },
    { id: "text", label: "텍스트 안전 영역", passed: sceneIssues.length === 0, detail: sceneIssues.join(" · ") || "실제 렌더링 영역에서 문구 잘림과 겹침 없음" },
    { id: "word_wrap", label: "단어 단위 줄바꿈", passed: plan.slides.every((slide) => !/[가-힣A-Za-z0-9]-\n[가-힣A-Za-z0-9]/.test(`${slide.title}\n${slide.body}\n${slide.bullets.join("\n")}`)), detail: "단어 중간 분리와 강제 하이픈 줄바꿈 금지" },
    { id: "korean_typesetting", label: "한국어 조판 안전성", passed: plan.slides.every(hasSafeKoreanLines), detail: "어절·괄호·구분점이 부자연스럽게 끊기지 않고 지정 줄 수 안에 배치" },
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
    { id: "buyer_hooks", label: "담당자 선택 포인트", passed: decisionHooksReady, detail: "제안 적합성·공식 근거·선택 구성 또는 운영 조건을 세 문장으로 제시" },
    { id: "takeaway_titles", label: "결론형 페이지 제목", passed: takeawayTitlesReady, detail: "단순 분류명이 아니라 담당자가 기억할 결론을 제목으로 제시" },
    { id: "gallery_copy", label: "대표 장면 제목 정제", passed: plan.slides.filter((slide) => slide.type === "gallery").every((slide) => !/정리\s*사진|스크린샷|캡처|IMG[_-]?\d|DSC[_-]?\d|\.jpe?g|\.png/i.test(`${slide.title} ${slide.body}`)), detail: "파일명·사진 정리 문구·OCR 조각을 고객용 제목으로 사용하지 않음" },
    { id: "final_copy", label: "내부 제작 문구 제거", passed: plan.slides.every((slide) => !/PHOTO\s*BRIEF|VERIFIED|이미지\s*(준비|삽입|교체)|사실\s*확인\s*필요|입력해\s*주세요/i.test(`${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`)), detail: "고객에게 전달할 최종 문장만 표시" },
    { id: "source_markers", label: "내부 출처 표기 제거", passed: !/(?:^|\s)(?:원문\s*)?\d+\s*(?:p|페이지|슬라이드)(?:\s|$)/i.test(plan.slides.map((slide) => `${slide.eyebrow} ${slide.title} ${slide.body} ${slide.bullets.join(" ")}`).join("\n")), detail: "2p·페이지·슬라이드 같은 분석용 표기는 노트에만 보관" },
  ];
  const score = Math.round(checks.filter((check) => check.passed).length / checks.length * 100);
  return { score, checks, issues: checks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.detail}`) };
}

const qualityDimensionLabels: Record<DeckQualityDimensionId, string> = {
  content: "자료·경력 반영",
  typography: "글자·한국어 조판",
  imagery: "사진 선별·배치",
  design: "디자인 완성도",
  persuasion: "담당자 후킹·설득력",
};

function evaluateQualityMetrics(plan: DeckPlan, profile: ProfileData, assets: VisualAsset[], visualScores?: Partial<Record<DeckQualityDimensionId, number>>) {
  const audit = auditDeckQuality(plan, profile, assets);
  const checkMap = new Map(audit.checks.map((check) => [check.id, check]));
  const passRatio = (ids: string[]) => ids.filter((id) => checkMap.get(id)?.passed).length / Math.max(1, ids.length);
  const facts = buildDeckFacts(profile);
  const factIndexes = new Set(facts.map((_, index) => index));
  const coveredIndexes = new Set(plan.slides.filter((slide) => slide.type === "career").flatMap((slide) => slide.careerIndexes).filter((index) => factIndexes.has(index)));
  const awards = facts.map((fact, index) => fact.category === "award" ? index : -1).filter((index) => index >= 0);
  const factCoverage = facts.length ? coveredIndexes.size / facts.length : 1;
  const awardCoverage = awards.length ? awards.filter((index) => coveredIndexes.has(index)).length / awards.length : 1;
  const requiredOfferTypes = [
    profile.extractedItems.some((item) => item.type === "repertoire" && item.status !== "excluded") ? "program" : "",
    profile.extractedItems.some((item) => item.type === "program_configuration" && item.status !== "excluded") ? "team" : "",
  ].filter(Boolean);
  const offerCoverage = requiredOfferTypes.length ? requiredOfferTypes.filter((type) => plan.slides.some((slide) => slide.type === type)).length / requiredOfferTypes.length : 1;
  const requiresBookingConditions = profile.extractedItems.some((item) => ["performance_duration", "cast_size", "equipment", "technical_requirement"].includes(item.type) && item.status !== "excluded");
  const bookingCoverage = !requiresBookingConditions || hasConfirmedBookingConditions(profile) && plan.slides.some((slide) => slide.type === "strengths") ? 1 : 0;
  const identityCoverage = [profile.artistName.trim(), profile.primaryField.trim(), profile.purpose.trim(), profile.introduction.trim() || profile.tagline.trim()].filter(Boolean).length / 4;

  const contentDeterministic = Math.round(factCoverage * 45 + awardCoverage * 15 + offerCoverage * 15 + bookingCoverage * 10 + identityCoverage * 15);
  const typographyDeterministic = Math.round(passRatio(["text", "word_wrap", "korean_typesetting", "final_copy", "source_markers"]) * 100);
  const imageCheckScore = passRatio(["images", "image_quality", "image_identity", "background_quality", "image_role", "empty_gallery", "gallery_alignment", "gallery_photo"]);
  const visualPrioritySlides = plan.slides.filter((slide) => ["cover", "about", "strengths", "program", "team", "gallery", "contact"].includes(slide.type));
  const priorityImageCoverage = visualPrioritySlides.length ? visualPrioritySlides.filter((slide) => slide.imageRefs.length === 1).length / visualPrioritySlides.length : 0;
  const imageryDeterministic = Math.round(imageCheckScore * 72 + Math.min(1, priorityImageCoverage / .72) * 28);
  const layouts = new Set(plan.slides.slice(1, -1).map((slide) => slide.layout));
  const layoutVariety = Math.min(1, layouts.size / Math.min(3, Math.max(1, plan.slides.length - 2)));
  const designDeterministic = Math.round(passRatio(["structure", "purpose", "gallery_titles", "gallery_copy"]) * 75 + layoutVariety * 25);
  const videoReady = !normalizeVideoUrl(profile.videoUrl) || plan.slides.some((slide) => slide.type === "contact" && slide.bullets.some((bullet) => normalizeVideoUrl(bullet) === normalizeVideoUrl(profile.videoUrl)));
  const persuasionDeterministic = Math.round(passRatio(["structure", "offer_completeness", "evidence", "contact", "buyer_hooks", "takeaway_titles", "final_copy"]) * 90 + (videoReady ? 10 : 0));
  const deterministic: Record<DeckQualityDimensionId, number> = {
    content: contentDeterministic,
    typography: typographyDeterministic,
    imagery: imageryDeterministic,
    design: designDeterministic,
    persuasion: persuasionDeterministic,
  };
  const visualWeights: Record<DeckQualityDimensionId, number> = { content: .25, typography: .45, imagery: .55, design: .7, persuasion: .55 };
  const relatedChecks: Record<DeckQualityDimensionId, string[]> = {
    content: ["offer_completeness", "evidence"],
    typography: ["text", "word_wrap", "korean_typesetting", "final_copy", "source_markers"],
    imagery: ["images", "image_quality", "image_identity", "background_quality", "image_role", "empty_gallery", "gallery_alignment", "gallery_photo"],
    design: ["structure", "purpose", "gallery_titles", "gallery_copy"],
    persuasion: ["structure", "offer_completeness", "evidence", "contact", "buyer_hooks", "takeaway_titles", "final_copy"],
  };
  const metrics = (Object.keys(qualityDimensionLabels) as DeckQualityDimensionId[]).map((id): DeckQualityMetric => {
    const visualScore = visualScores?.[id];
    const score = visualScore === undefined ? Math.min(85, deterministic[id]) : Math.round(deterministic[id] * (1 - visualWeights[id]) + visualScore * visualWeights[id]);
    const issues = relatedChecks[id].filter((checkId) => !checkMap.get(checkId)?.passed).map((checkId) => checkMap.get(checkId)!.detail);
    if (id === "content" && factCoverage < .9) issues.push(`경력·수상 반영률 ${Math.round(factCoverage * 100)}%`);
    if (id === "imagery" && priorityImageCoverage < .72) issues.push(`핵심 페이지 사진 반영률 ${Math.round(priorityImageCoverage * 100)}%`);
    if (visualScore !== undefined && visualScore < 90) issues.push(`Gemini 시각 평가 ${visualScore}점`);
    return {
      id,
      label: qualityDimensionLabels[id],
      score,
      passed: score >= 90,
      detail: `${score}점 · ${score >= 90 ? "출고 기준 통과" : "자동 보정 또는 자료 보완 필요"}`,
      issues: [...new Set(issues)].slice(0, 5),
    };
  });
  return { ...audit, metrics, releaseReady: metrics.every((metric) => metric.passed) && checkMap.get("scene_fit")?.passed === true, releaseScore: Math.min(...metrics.map((metric) => metric.score)) };
}

function careerFactVisualWeight(fact?: DeckFact) {
  if (!fact) return 1;
  const display = formatCareerFact(fact, false);
  const titleWeight = Math.max(0, koreanTextWidth(display.title) - 28) / 34;
  const metaWeight = Math.max(0, koreanTextWidth(display.meta) - 36) / 52;
  return Math.min(2.25, 1 + titleWeight + metaWeight);
}

function splitCareerIndexesForLayout(indexes: number[], facts: DeckFact[]) {
  const pages: number[][] = [];
  let current: number[] = [];
  let currentWeight = 0;
  for (const index of [...new Set(indexes)]) {
    const weight = careerFactVisualWeight(facts[index]);
    const wouldOverflow = current.length >= 6 || current.length >= 3 && currentWeight + weight > 6.35;
    if (current.length && wouldOverflow) {
      pages.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(index);
    currentWeight += weight;
  }
  if (current.length) pages.push(current);
  return pages;
}

function paginateSlideCopy(slides: DeckSlidePlan[], profile: ProfileData) {
  const facts = buildDeckFacts(profile);
  const titleCounts = new Map<string, number>();
  return slides.flatMap((slide) => {
    if (slide.type !== "career") return [slide];
    const pages = splitCareerIndexesForLayout(slide.careerIndexes, facts);
    if (!pages.length) return [];
    return pages.map((careerIndexes, pageIndex) => {
      const pageFacts = careerIndexes.map((index) => facts[index]).filter(Boolean);
      const baseTitle = pageIndex ? careerSlideTitle(pageFacts) : slide.title || careerSlideTitle(pageFacts);
      const occurrence = titleCounts.get(baseTitle) || 0;
      const pageTextWeight = careerIndexes.reduce((total, index) => total + careerFactVisualWeight(facts[index]), 0);
      titleCounts.set(baseTitle, occurrence + 1);
      return {
        ...slide,
        title: distinctCareerSlideTitle(baseTitle, occurrence),
        careerIndexes,
        // A photo leaves room for only three career rows. Four rows extend
        // below the 7.5-inch canvas; switch to the full-width two-column layout.
        imageRefs: pageIndex || careerIndexes.length > CAREER_PHOTO_CAPACITY || pageTextWeight > 5.2 ? [] : slide.imageRefs,
        layout: pageIndex || careerIndexes.length > CAREER_PHOTO_CAPACITY || pageTextWeight > 5.2 ? "timeline" as const : slide.layout,
      };
    });
  });
}

function fitSlideCopy(slide: DeckSlidePlan): DeckSlidePlan {
  const budgets = {
    cover: [26, 42, 0, 0], about: [32, 105, 3, 38], strengths: [32, 0, 3, 48], program: [32, 46, 6, 36], team: [32, 46, 4, 42],
    gallery: [32, 42, 0, 0], career: [32, 0, 0, 0], contact: [30, 60, 2, 48],
  } as const;
  const [title, body, bulletCount, bulletLength] = budgets[slide.type];
  return {
    ...slide,
    eyebrow: normalizeKoreanDisplayText(slide.eyebrow),
    title: normalizeKoreanDisplayText(slide.title),
    body: body ? normalizeKoreanDisplayText(slide.body) : "",
    bullets: slide.bullets.slice(0, bulletCount).map(normalizeKoreanDisplayText),
    careerIndexes: slide.careerIndexes.slice(0, slide.type === "career" ? 6 : slide.type === "strengths" ? 3 : slide.type === "gallery" ? 1 : 0),
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
  return pageCount >= 12 ? 25 : pageCount >= 10 ? 20 : 10;
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
    if (pages.length < pageCount && group.length) pages.push(group.splice(0, 6));
  });
  const leftovers = groups.flat();
  while (leftovers.length && pages.length < pageCount) pages.push(leftovers.splice(0, 6));
  leftovers.forEach((factIndex) => {
    const target = pages.find((page) => page.length < 6);
    if (target) target.push(factIndex);
  });
  return pages.slice(0, pageCount);
}

function extractedProfileValues(profile: ProfileData, type: "repertoire" | "program_configuration", limit: number) {
  return [...new Set(profile.extractedItems
    .filter((item) => item.type === type && item.status !== "excluded")
    .map((item) => item.value.replace(/\s+/g, " ").trim())
    .filter(Boolean))].slice(0, limit);
}

function proposalBullets(profile: ProfileData) {
  const configurations = extractedProfileValues(profile, "program_configuration", 4);
  const repertoire = extractedProfileValues(profile, "repertoire", 6);
  return buildDecisionHookBullets({ ...profile, configurations, repertoire }, buildDeckFacts(profile));
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
        title: compactText(buildDecisionHookTitle(profile), 32),
        body: "",
        bullets: proposalBullets(profile),
      };
      if (slide.type === "about") return { ...slide, bullets: aboutProofBullets(profile) };
      if (slide.type === "program") return { ...slide, eyebrow: "공연 프로그램", title: "행사 성격에 맞춰 선택하는 레퍼토리", body: "", bullets: extractedProfileValues(profile, "repertoire", 6), careerIndexes: [] };
      if (slide.type === "team") return { ...slide, eyebrow: "출연 구성", title: "공간과 예산에 맞춰 고르는 팀 구성", body: "", bullets: extractedProfileValues(profile, "program_configuration", 4), careerIndexes: [] };
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
  const repertoire = extractedProfileValues(profile, "repertoire", 6);
  const programConfigurations = extractedProfileValues(profile, "program_configuration", 4);
  const slides: DeckSlidePlan[] = [
    { type: "cover", eyebrow: "아티스트 섭외 제안", title: profile.artistName || "ARTIST", body: purposeTitle, bullets: [], imageRefs: visualAssets[0] ? [visualAssets[0].id] : [], imagePurpose: "얼굴과 분위기가 선명한 세로 대표사진 · 반신 또는 전신", careerIndexes: evidenceAt(0), layout: "split_right" },
    { type: "about", eyebrow: "아티스트 소개", title: compactText(profile.tagline || `${profile.primaryField}로 만드는 무대`, 32), body: compactText(profile.introduction, 105), bullets: aboutProofBullets(profile), imageRefs: visualAssets[1] ? [visualAssets[1].id] : [], imagePurpose: "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장", careerIndexes: evidenceAt(1), layout: "split_right" },
    { type: "strengths", eyebrow: hasConfirmedBookingConditions(profile) ? "섭외 조건" : "제안 무대", title: compactText(buildDecisionHookTitle(profile), 32), body: "", bullets: proposalBullets(profile), imageRefs: [], imagePurpose: "", careerIndexes: proposalFactIndexes.slice(0, 3), layout: "editorial" },
  ];
  if (repertoire.length) slides.push({ type: "program", eyebrow: "공연 프로그램", title: "행사 성격에 맞춰 선택하는 레퍼토리", body: "", bullets: repertoire, imageRefs: [], imagePurpose: "레퍼토리의 장르와 무대 분위기를 보여주는 실제 활동 사진", careerIndexes: [], layout: "split_right" });
  if (programConfigurations.length) slides.push({ type: "team", eyebrow: "출연 구성", title: "공간과 예산에 맞춰 고르는 팀 구성", body: "", bullets: programConfigurations, imageRefs: [], imagePurpose: "출연 인원과 팀 구성을 한눈에 보여주는 단체 활동 사진", careerIndexes: [], layout: "split_left" });
  const offerSlideCount = Number(Boolean(repertoire.length)) + Number(Boolean(programConfigurations.length));
  const desiredCareerPageCount = Math.max(1, Math.min(profile.pageCount >= 12 ? 5 : profile.pageCount >= 10 ? 4 : 2, Math.ceil(proposalFactIndexes.length / 8)));
  const galleryAssets = visualAssets.slice(2, 2 + Math.min(5, Math.max(0, profile.pageCount - 4 - offerSlideCount - desiredCareerPageCount)));
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
  const careerPageCount = Math.max(1, Math.min(desiredCareerPageCount, profile.pageCount - 4 - offerSlideCount - galleryAssets.length));
  const careerPages = paginateCareerFactIndexes(proposalFactIndexes, deckFacts, careerPageCount);
  const careerTitleCounts = new Map<string, number>();
  for (const pageIndexes of careerPages) {
    const baseTitle = careerSlideTitle(pageIndexes.map((factIndex) => deckFacts[factIndex]).filter(Boolean));
    const occurrence = careerTitleCounts.get(baseTitle) || 0;
    careerTitleCounts.set(baseTitle, occurrence + 1);
    slides.push({ type: "career", eyebrow: "주요 경력", title: distinctCareerSlideTitle(baseTitle, occurrence), body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: pageIndexes, layout: "timeline" });
  }
  const contact: DeckSlidePlan = {
    type: "contact",
    eyebrow: "섭외 문의",
    title: "가능 일정과 출연 조건을 확인해 보세요",
    body: [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · "),
    bullets: [profile.contact, profile.videoUrl || profile.officialUrl].filter(Boolean),
    imageRefs: [], imagePurpose: "", careerIndexes: evidenceAt(4), layout: "editorial",
  };
  return enforceDeckSafety({ narrative: "고객이 얻을 현장 가치, 실제 장면, 검증된 경력, 섭외 행동 순서로 선택을 지원", visualDirection: "고객 관점의 짧은 결론과 출처가 분명한 실제 이미지 중심", slides: paginateSlideCopy([...slides, contact], profile).map(fitSlideCopy) });
}

function ensureVisualCoverage(plan: DeckPlan, assets: VisualAsset[], profile: ProfileData): DeckPlan {
  if (!assets.length) return { ...plan, slides: plan.slides.map((slide) => ({ ...slide, imageRefs: [] })) };
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const preferredRoles: Record<DeckSlidePlan["type"], ProfileVisualRole[]> = {
    cover: ["portrait", "stage", "other"],
    about: ["stage", "portrait", "other"],
    strengths: ["stage", "other", "portrait"],
    program: ["stage", "other", "portrait"],
    team: ["stage", "other", "portrait"],
    gallery: ["stage", "other"],
    career: ["history", "poster", "stage", "other"],
    contact: ["portrait", "stage", "other"],
  };
  const assetFitsSlide = (asset: VisualAsset, type: DeckSlidePlan["type"]) => {
    const role = asset.visualRole || "other";
    if (!preferredRoles[type].includes(role)) return false;
    if (["cover", "about", "strengths", "program", "team", "gallery", "contact"].includes(type) && asset.visualType === "graphic") return false;
    return true;
  };
  const used = new Set<string>();
  let slides: DeckSlidePlan[] = plan.slides.map((slide) => {
    const selectedId = slide.imageRefs.find((id) => {
      const asset = assetMap.get(id);
      return Boolean(asset && !used.has(id) && assetFitsSlide(asset, slide.type) && (slide.type !== "career" || slide.careerIndexes.length <= 3));
    });
    if (selectedId) used.add(selectedId);
    const selected = selectedId ? assetMap.get(selectedId) : undefined;
    const fallbackLayout = slide.type === "career" ? "timeline" : slide.type === "gallery" ? "gallery" : "editorial";
    const layout = slide.layout === "full_bleed" && (!selected || !canUseAsBackground(selected, slide.type)) ? fallbackLayout : slide.layout;
    return { ...slide, bullets: [...slide.bullets], careerIndexes: [...slide.careerIndexes], imageRefs: selectedId ? [selectedId] : [], layout };
  });
  const coverIndex = slides.findIndex((slide) => slide.type === "cover");
  if (coverIndex < 0) slides.unshift({ type: "cover", eyebrow: "ARTIST PROFILE", title: profile.artistName || "ARTIST", body: profile.tagline, bullets: [], imageRefs: [], imagePurpose: "대표사진", careerIndexes: [], layout: "split_right" });
  const normalizedCoverIndex = slides.findIndex((slide) => slide.type === "cover");
  const available = assets.filter((asset) => !used.has(asset.id));
  const takeAsset = (type: DeckSlidePlan["type"]) => {
    for (const role of preferredRoles[type]) {
      const index = available.findIndex((asset) => (asset.visualRole || "other") === role && assetFitsSlide(asset, type));
      if (index >= 0) {
        const selected = available.splice(index, 1)[0];
        used.add(selected.id);
        return selected;
      }
    }
    return undefined;
  };
  const existingCover = slides[normalizedCoverIndex].imageRefs[0] ? assetMap.get(slides[normalizedCoverIndex].imageRefs[0]) : undefined;
  const coverAsset = existingCover || takeAsset("cover");
  if (coverAsset) {
    slides[normalizedCoverIndex].imageRefs = [coverAsset.id];
    if (slides[normalizedCoverIndex].layout === "full_bleed" && !canUseAsBackground(coverAsset, "cover")) slides[normalizedCoverIndex].layout = "split_right";
  }

  let aboutIndex = slides.findIndex((slide) => slide.type === "about");
  if (aboutIndex < 0) {
    slides.splice(normalizedCoverIndex + 1, 0, { type: "about", eyebrow: "ARTIST IDENTITY", title: profile.tagline || `${profile.primaryField}로 만드는 무대`, body: profile.introduction, bullets: aboutProofBullets(profile), imageRefs: [], imagePurpose: "대표 활동사진", careerIndexes: [], layout: "split_right" });
    aboutIndex = normalizedCoverIndex + 1;
  }
  if (!slides[aboutIndex].imageRefs.length) {
    const aboutAsset = takeAsset("about");
    if (aboutAsset) slides[aboutIndex].imageRefs = [aboutAsset.id];
  }
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
  let stageGalleryCount = 0;
  slides.forEach((slide) => {
    if (slide.type === "cover" || slide.type === "about") return;
    const careerTextWeight = slide.type === "career"
      ? slide.careerIndexes.reduce((total, factIndex) => total + careerFactVisualWeight(deckFacts[factIndex]), 0)
      : 0;
    const existing = slide.imageRefs[0] ? assetMap.get(slide.imageRefs[0]) : undefined;
    const asset = existing || (slide.type === "career" && (slide.careerIndexes.length > 3 || careerTextWeight > 4.65) ? undefined : takeAsset(slide.type));
    slide.imageRefs = asset ? [asset.id] : [];
    if (slide.type === "gallery" && asset && !slide.careerIndexes.length) slide.careerIndexes = matchingFactIndexes(asset);
    slide.imagePurpose ||= slide.type === "career" ? "해당 활동과 연결되는 현장 사진" : slide.type === "contact" ? "아티스트를 기억하게 만드는 마무리 사진" : "페이지 메시지를 뒷받침하는 활동 사진";
    const genericGalleryCopy = /^(대표 활동|실제 활동|또 하나의 대표 장면|이 무대를 기억|무대에서 드러나는|현장 호흡|공간의 분위기|관객과 만나는|행사의 인상)/.test(slide.title.trim());
    if (slide.type === "gallery" && asset?.visualRole === "stage" && genericGalleryCopy) {
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
    if (slide.layout === "full_bleed" && (!asset || !canUseAsBackground(asset, slide.type))) slide.layout = slide.type === "gallery" ? "gallery" : slide.type === "career" ? "timeline" : "editorial";
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

function ensureCompleteCareerCoverage(plan: DeckPlan, profile: ProfileData): DeckPlan {
  const facts = buildDeckFacts(profile);
  if (!facts.length) return plan;
  const slides = plan.slides.map((slide) => ({ ...slide, careerIndexes: [...slide.careerIndexes] }));
  const careerSlides = slides.filter((slide) => slide.type === "career");
  const covered = new Set(careerSlides.flatMap((slide) => slide.careerIndexes).filter((index) => facts[index]));
  const missing = rankDeckFactIndexes(facts, profile.purpose, facts.length).filter((index) => !covered.has(index));
  if (!missing.length) return plan;
  if (careerSlides.length) {
    careerSlides[careerSlides.length - 1].careerIndexes.push(...missing);
  } else {
    const careerSlide: DeckSlidePlan = { type: "career", eyebrow: "주요 경력", title: careerSlideTitle(missing.map((index) => facts[index]).filter(Boolean)), body: "", bullets: [], imageRefs: [], imagePurpose: "", careerIndexes: missing, layout: "timeline" };
    const contactIndex = slides.findIndex((slide) => slide.type === "contact");
    slides.splice(contactIndex >= 0 ? contactIndex : slides.length, 0, careerSlide);
  }
  return { ...plan, slides };
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
  return response.json() as Promise<{ plan: DeckPlan; mode: "ai"; provider: string; model: string; promptVersion?: string; qualityScore?: number; coveredFactCount?: number; totalFactCount?: number }>;
}

async function requestDeckVisualReview(plan: DeckPlan, profile: ProfileData, assets: VisualAsset[], iteration: number) {
  const template = getTemplate(profile.templateKey);
  const assetData = new Map(assets.map((asset) => [asset.id, asset]));
  const frames = await renderDeckQaFrames(plan, profile, template, assetData);
  if (!frames.length) throw new Error("시각 검수 프레임을 만들지 못했습니다.");
  const facts = buildDeckFacts(profile);
  const profileEvidence = {
    artistName: profile.artistName,
    primaryField: profile.primaryField,
    region: profile.region,
    purpose: profile.purpose,
    performanceDuration: profile.performanceDuration,
    castSize: profile.castSize,
    technicalRequirements: profile.technicalRequirements,
    careers: facts.map((fact, index) => ({ index, date: fact.date, title: fact.title, organization: fact.organization, category: fact.category })),
    visualAssets: assets.map((asset) => ({ id: asset.id, origin: asset.origin, role: asset.visualRole || "other", type: asset.visualType || "photo", width: asset.pixelWidth || 0, height: asset.pixelHeight || 0, qualityScore: asset.qualityScore ?? 0 })),
  };
  const response = await fetch("/api/ai/review-deck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: profileEvidence, plan, frames, iteration }) });
  if (!response.ok) {
    const details = await response.json().catch(() => null) as { error?: string; code?: string } | null;
    const error = new Error(details?.error || "Gemini 시각 검수를 완료하지 못했습니다.") as Error & { code?: string };
    error.code = details?.code;
    throw error;
  }
  return response.json() as Promise<DeckVisualReviewResult>;
}

function applyVisualReview(plan: DeckPlan, review: DeckVisualReviewResult, assets: VisualAsset[]) {
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  let revisedCount = 0;
  const slides = plan.slides.map((slide, slideIndex) => {
    const result = review.slides.find((item) => item.slideIndex === slideIndex);
    if (!result || result.verdict !== "revise" || result.score >= 90 || !result.revision) return slide;
    revisedCount += 1;
    const firstAsset = slide.imageRefs[0] ? assetMap.get(slide.imageRefs[0]) : undefined;
    const requestedLayout = result.revision.layout;
    const layout = requestedLayout === "full_bleed" && (!firstAsset || !canUseAsBackground(firstAsset, slide.type))
      ? slide.layout === "full_bleed" ? "split_right" : slide.layout
      : requestedLayout;
    return {
      ...slide,
      title: result.revision.title || slide.title,
      body: result.revision.body,
      bullets: result.revision.bullets,
      layout,
      imageRefs: [...slide.imageRefs],
      careerIndexes: [...slide.careerIndexes],
    };
  });
  return { plan: { ...plan, slides }, revisedCount };
}

async function runVisualReviewLoop(plan: DeckPlan, profile: ProfileData, assets: VisualAsset[]) {
  let current = plan;
  let score = 0;
  let iterations = 0;
  let issues: string[] = [];
  let version = "";
  let dimensionScores: Record<DeckQualityDimensionId, number> = { content: 0, typography: 0, imagery: 0, design: 0, persuasion: 0 };
  for (let iteration = 1; iteration <= 2; iteration += 1) {
    const review = await requestDeckVisualReview(current, profile, assets, iteration);
    iterations = iteration;
    score = review.overallScore;
    dimensionScores = review.dimensionScores;
    issues = [...new Set([...review.deckIssues, ...review.slides.filter((slide) => slide.score < 90).flatMap((slide) => slide.issues.map((issue) => `${slide.slideIndex + 1}페이지 · ${issue}`))])].slice(0, 12);
    version = review.reviewVersion;
    // Never approve a revision using the previous scene's score. The last
    // returned plan is always the exact plan evaluated in the last request.
    if (score >= 90 && Object.values(dimensionScores).every(value => value >= 90) || iteration === 2) break;
    const revised = applyVisualReview(current, review, assets);
    if (revised.revisedCount === 0) break;
    const synchronized = synchronizeProposalSlide(revised.plan, profile);
    current = normalizeNarrativeStructure(enforceDeckSafety({ ...synchronized, slides: paginateSlideCopy(synchronized.slides, profile).map(fitSlideCopy) }), profile);
    if (score >= 90 && Object.values(dimensionScores).every((value) => value >= 90) || revised.revisedCount === 0) break;
  }
  return { plan: current, score, iterations, issues, version, dimensionScores };
}

export async function prepareDeckPlan(profile: ProfileData, existingPlan?: DeckPlan): Promise<{ plan: DeckPlan; meta: DeckPlanMeta }> {
  const assets = await prepareVisualAssets(profile);
  try {
    const result = existingPlan ? { plan: existingPlan, provider: profile.deckPlanMeta?.provider || "Gemini", model: profile.deckPlanMeta?.model || "", promptVersion: profile.deckPlanMeta?.promptVersion, coveredFactCount: profile.deckPlanMeta?.coveredFactCount, totalFactCount: profile.deckPlanMeta?.totalFactCount } : await requestDeckPlan(profile, assets);
    const coveredPlan = ensureCompleteCareerCoverage(ensureEvidenceCoverage(ensureVisualCoverage(synchronizeProposalSlide(result.plan, profile), assets, profile), profile), profile);
    const safePlan = enforceDeckSafety({ ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides, profile).map(fitSlideCopy) });
    let finalPlan = existingPlan || normalizeNarrativeStructure(safePlan, profile);
    let visualQualityScore: number | undefined;
    let visualReviewIterations = 0;
    let visualQualityIssues: string[] = [];
    let visualDimensionScores: Partial<Record<DeckQualityDimensionId, number>> | undefined;
    let reviewVersion = "";
    let reviewWarning = "";
    try {
      const visualReview = await runVisualReviewLoop(finalPlan, profile, assets);
      finalPlan = visualReview.plan;
      visualQualityScore = visualReview.score;
      visualReviewIterations = visualReview.iterations;
      visualQualityIssues = visualReview.issues;
      visualDimensionScores = visualReview.dimensionScores;
      reviewVersion = visualReview.version;
    } catch (error) {
      reviewWarning = error instanceof Error ? error.message : "시각 검수를 완료하지 못했습니다.";
    }
    const quality = evaluateQualityMetrics(finalPlan, profile, assets, visualDimensionScores);
    const visualReleaseReady = visualQualityScore !== undefined && visualQualityScore >= 90 && Object.values(visualDimensionScores ?? {}).length === 5 && Object.values(visualDimensionScores ?? {}).every((value) => value >= 90);
    const releaseReady = quality.releaseReady && visualReleaseReady;
    const releaseScore = visualQualityScore === undefined ? quality.releaseScore : Math.min(quality.releaseScore, visualQualityScore, ...Object.values(visualDimensionScores ?? {}));
    const visualCheck = { id: "visual_review", label: "AI 시각 출고 검사", passed: visualReleaseReady, detail: visualQualityScore === undefined ? reviewWarning || "시각 검수를 실행하지 못했습니다." : `${reviewVersion || "visual-director"} · ${visualReviewIterations}회 검수 · ${visualQualityScore}점` };
    const metricChecks = quality.metrics.map((metric): DeckQualityCheck => ({ id: `quality_${metric.id}`, label: metric.label, passed: metric.passed, detail: metric.detail }));
    const qualityChecks = [...metricChecks, ...quality.checks, visualCheck];
    const metricIssues = quality.metrics.filter((metric) => !metric.passed).flatMap((metric) => metric.issues.length ? metric.issues.map((issue) => `${metric.label}: ${issue}`) : [`${metric.label}: ${metric.score}점`]);
    const qualityIssues = [...new Set([...quality.issues, ...metricIssues, ...visualQualityIssues, ...(visualQualityScore === undefined ? [`AI 시각 출고 검사: ${reviewWarning || "실행하지 못했습니다."}`] : [])])];
    const failedMetricSummary = quality.metrics.filter((metric) => !metric.passed).map((metric) => `${metric.label} ${metric.score}점`);
    if (!visualReleaseReady) failedMetricSummary.push(`AI 시각 출고 검사 ${visualQualityScore ?? 0}점`);
    const releaseWarning = releaseReady ? reviewWarning : `90점 출고 기준 미달 · ${failedMetricSummary.join(" · ")}`;
    return { plan: finalPlan, meta: { layoutVersion: SLIDE_LAYOUT_VERSION, mode: "ai", provider: result.provider, model: result.model, promptVersion: result.promptVersion, warning: releaseWarning || undefined, qualityScore: releaseScore, visualQualityScore, visualReviewIterations, visualQualityIssues, qualityMetrics: quality.metrics, releaseReady, coveredFactCount: result.coveredFactCount, totalFactCount: result.totalFactCount, qualityChecks, qualityIssues } };
  } catch (error) {
    const failure = error as Error & { code?: string };
    const coveredLocalPlan = ensureCompleteCareerCoverage(ensureEvidenceCoverage(ensureVisualCoverage(synchronizeProposalSlide(fallbackPlan(profile, assets), profile), assets, profile), profile), profile);
    const localPlan = normalizeNarrativeStructure(enforceDeckSafety({ ...coveredLocalPlan, slides: paginateSlideCopy(coveredLocalPlan.slides, profile).map(fitSlideCopy) }), profile);
    const quality = evaluateQualityMetrics(localPlan, profile, assets);
    return {
      plan: localPlan,
      meta: {
        layoutVersion: SLIDE_LAYOUT_VERSION,
        mode: "local",
        provider: "기본 기획",
        model: "로컬",
        warning: failure.message || "Gemini PPT 기획을 완료하지 못했습니다.",
        errorCode: failure.code || "DECK_PLANNING_FAILED",
        qualityScore: quality.releaseScore,
        qualityMetrics: quality.metrics,
        releaseReady: false,
        qualityChecks: [...quality.metrics.map((metric): DeckQualityCheck => ({ id: `quality_${metric.id}`, label: metric.label, passed: false, detail: metric.detail })), ...quality.checks],
        qualityIssues: [...quality.issues, "Gemini 시각 출고검사가 없어 90점 출고 기준을 통과할 수 없습니다."],
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
  const hasPreparedReviewedPlan = Boolean(profile.deckPlan && profile.deckPlanMeta && profile.deckPlanMeta.layoutVersion === SLIDE_LAYOUT_VERSION && profile.deckPlanMeta.releaseReady !== undefined && (profile.deckPlanMeta.visualReviewIterations ?? 0) > 0);
  const prepared: { plan: DeckPlan; meta: DeckPlanMeta } = hasPreparedReviewedPlan
    ? { plan: profile.deckPlan!, meta: profile.deckPlanMeta! }
    : await prepareDeckPlan(profile);
  const coveredPlan = hasPreparedReviewedPlan
    ? ensureCompleteCareerCoverage(prepared.plan, profile)
    : ensureCompleteCareerCoverage(ensureEvidenceCoverage(ensureVisualCoverage(synchronizeProposalSlide(prepared.plan, profile), assets, profile), profile), profile);
  // Preserve the exact plan that was previewed and reviewed with this renderer.
  const plan = hasPreparedReviewedPlan ? prepared.plan : normalizeNarrativeStructure(enforceDeckSafety({ ...coveredPlan, slides: paginateSlideCopy(coveredPlan.slides, profile).map(fitSlideCopy) }), profile);
  const exportMeta = prepared.meta;
  const failedMetrics = (exportMeta.qualityMetrics ?? []).filter((metric) => metric.score < 90);
  if (!exportMeta.releaseReady || failedMetrics.length) {
    const details = failedMetrics.length ? failedMetrics.map((metric) => `${metric.label} ${metric.score}점`).join(" · ") : "Gemini 최종 출고검사 미완료";
    throw new Error(`90점 출고 기준을 통과하지 못했습니다. ${details}. ‘PPT 구성 자동 완성’을 다시 실행하거나 부족한 사진·자료를 보완해 주세요.`);
  }
  const deckFacts = buildDeckFacts(profile);

  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Artfolio Studio";
  pptx.subject = `${profile.artistName} 예술인 프로필`;
  pptx.title = `${profile.artistName || "예술인"} Profile`;
  pptx.company = "Artfolio";
  pptx.theme = { headFontFace: template.typography.heading, bodyFontFace: template.typography.body };

  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const scenes = plan.slides.map((slidePlan, index) => buildSlideScene(slidePlan, index, profile, template, assetMap));
  const layoutIssues = scenes.flatMap((scene, index) => inspectSlideScene(scene).map(issue => `${index + 1}페이지: ${issue}`));
  if (layoutIssues.length) throw new Error(`PPT 배치 보완이 필요합니다. ${layoutIssues.slice(0, 3).join(" · ")}`);
  plan.slides.forEach((slidePlan, index) => {
    const scene = scenes[index];
    const slide = pptx.addSlide();
    slide.background = { color: hex(scene.background) };
    for (const node of scene.nodes) {
      const frame = { x: node.x, y: node.y, w: node.w, h: node.h };
      if (node.type === "rect") slide.addShape(pptx.ShapeType.rect, { ...frame, fill: { color: hex(node.color) }, line: { color: hex(node.color), transparency: 100 } });
      else if (node.type === "image") slide.addImage({ ...frame, data: node.asset.dataUrl, altText: node.asset.sourceTitle || slidePlan.imagePurpose || profile.artistName });
      else slide.addText(node.text, { ...frame, fontFace: node.fontFace, fontSize: node.fontSize, bold: node.bold, color: hex(node.color), margin: 0, valign: "top", breakLine: false, fit: "shrink", paraSpaceAfter: 0, lineSpacingMultiple: 1.24, hyperlink: node.href ? { url: node.href } : undefined });
    }
    const sourceNotes = slidePlan.careerIndexes.map(i => deckFacts[i]).filter(Boolean).map(fact => [fact.sourceName, fact.sourceUrl].filter(Boolean).join(": "));
    const conditionNotes = slidePlan.type === "strengths" ? profile.extractedItems.filter(item => ["performance_duration", "cast_size", "technical_requirement"].includes(item.type) && item.status !== "excluded").map(item => [item.label, item.value, item.sourceUrl, item.pageNumber ? "원문 " + item.pageNumber + "p" : ""].filter(Boolean).join(" · ")) : [];
    slide.addNotes([...scene.notes, ...sourceNotes, ...conditionNotes].filter(Boolean).join("\n"));
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
  return { ...exportMeta, qualityScore: exportMeta.qualityScore, qualityIssues: [...new Set([...quality.issues, ...(exportMeta.qualityIssues ?? []), ...(exportMeta.visualQualityIssues ?? [])])], slideCount: plan.slides.length };
}
