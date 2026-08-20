"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, CircleHelp, Download, FileText,
  ImagePlus, LayoutTemplate, Loader2, Menu, PenLine, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, WandSparkles, X,
} from "lucide-react";
import { ExternalImageAsset, ExtractedItem, initialProfile, PdfExtractedVisual, PdfPageAsset, ProfileData, ProfileImageCategory, ProfileVisualRole, SourceType } from "@/types/profile";
import { designTemplates, getTemplate, recommendTemplateKey } from "@/features/design-templates/registry/templates";
import { FILE_LIMITS } from "@/config/file-limits";
import { collectDeckAssets, downloadPptx, getDeckAssetData, isYouTubeVideoUrl, makeImageThumbnail, normalizeVideoUrl, prepareDeckPlan, selectPortfolioAssets } from "@/features/profile-export/pptx/generate-pptx";
import { buildDeckFacts, formatCareerFact, formatCustomerValueEvidence } from "@/features/profile-export/pptx/deck-facts";
import { clearProfileDraft, loadProfileDraft, saveProfileDraft } from "@/features/profile-source/services/draft-storage";
import { analyzePdfInBrowser } from "@/features/pdf-import/services/analyze-pdf-browser";
import { inferItemsFromText } from "@/features/pdf-import/parsers/extract-items";
import { useSiteSettings } from "@/features/site-settings/SiteSettingsProvider";

interface PdfUploadResponse {
  text: string;
  items: ExtractedItem[];
  pages: PdfPageAsset[];
  ocrPageCount: number;
  warnings: string[];
  analysisMode?: "server" | "browser";
}

interface PptxUploadResponse {
  text: string;
  slideCount: number;
  totalImageCount: number;
  selectedImageCount: number;
  mode: "ai" | "size_fallback";
  images: Array<{ dataUrl: string; role: "representative" | "activity" | "poster" | "history"; slideNumbers: number[]; relevanceScore: number; qualityScore: number; reason: string }>;
}

interface AiExtractionResponse {
  mode: "ai";
  items: ExtractedItem[];
  profile: {
    artistName: string;
    artistType: "개인" | "단체" | "알 수 없음";
    primaryField: string;
    secondaryFields: string[];
    region: string;
    members: string[];
    contacts: string[];
    socialLinks: string[];
    introduction: string;
    tagline: string;
    strengths: string[];
    facts: Array<{
      category: "career" | "performance" | "award" | "media";
      date: string;
      title: string;
      organization: string;
      location: string;
      description: string;
      pageNumber: number;
      confidence: number;
    }>;
    visualRegions: Array<{ pageNumber: number; x: number; y: number; width: number; height: number; kind: "photo" | "graphic"; description: string; confidence: number }>;
  };
  provider: "gemini" | "openai";
  model: string;
}

interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
}

interface ProfileLinkResponse {
  url: string;
  title: string;
  text: string;
  sourceName: string;
  verificationTier: "primary" | "platform" | "reference";
  error?: string;
}

interface WebImageCandidate extends ExternalImageAsset {
  imageUrl: string;
  width: number;
  height: number;
  recommended: boolean;
  reason: string;
  rightsRisk?: "low" | "unknown" | "high";
  identityScore?: number;
  identityConflicts?: string[];
}

interface GeneratedProfileImage {
  id: string;
  dataUrl: string;
  title: string;
  promptBasis: string;
  disclosure: string;
}

async function cropAiVisualRegions(pages: PdfPageAsset[], regions: AiExtractionResponse["profile"]["visualRegions"] = []) {
  const grouped = new Map<number, typeof regions>();
  regions.filter((region) => region.confidence >= 0.65 && region.width * region.height <= 0.8 && region.width >= 0.12 && region.height >= 0.12).forEach((region) => grouped.set(region.pageNumber, [...grouped.get(region.pageNumber) ?? [], region]));
  return Promise.all(pages.map(async (page) => {
    if (page.extractedVisuals?.length || !grouped.has(page.pageNumber)) return page;
    const image = await new Promise<HTMLImageElement | null>((resolve) => { const target = new Image(); target.onload = () => resolve(target); target.onerror = () => resolve(null); target.src = page.previewDataUrl; });
    if (!image) return page;
    const extractedVisuals: PdfExtractedVisual[] = [];
    for (const region of grouped.get(page.pageNumber)!.slice(0, 4)) {
      const sx = Math.max(0, Math.round(region.x * image.naturalWidth));
      const sy = Math.max(0, Math.round(region.y * image.naturalHeight));
      const width = Math.min(image.naturalWidth - sx, Math.round(region.width * image.naturalWidth));
      const height = Math.min(image.naturalHeight - sy, Math.round(region.height * image.naturalHeight));
      if (width < 160 || height < 120) continue;
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      canvas.getContext("2d")?.drawImage(image, sx, sy, width, height, 0, 0, width, height);
      extractedVisuals.push({ id: `p${page.pageNumber}-ai-visual-${extractedVisuals.length + 1}`, dataUrl: canvas.toDataURL("image/jpeg", 0.9), width, height, kind: region.kind, selected: true });
    }
    return { ...page, extractedVisuals };
  }));
}

const visualRoleLabels: Record<ProfileVisualRole, string> = {
  portrait: "인물·대표사진",
  stage: "무대·활동사진",
  poster: "포스터·홍보물",
  history: "연혁·수상자료",
  other: "보조 이미지",
  exclude: "사용 제외",
};

async function classifyDocumentVisuals(pages: PdfPageAsset[], artistName: string, primaryField: string) {
  const inputs = pages.flatMap((page) => (page.extractedVisuals ?? []).map((visual) => ({ page, visual }))).slice(0, 16);
  if (!inputs.length) return pages;
  try {
    const images = await Promise.all(inputs.map(async ({ page, visual }) => ({
      id: visual.id,
      dataUrl: await makeImageThumbnail(visual.dataUrl, 640),
      pageNumber: page.pageNumber,
      pageText: page.text.slice(0, 900),
      width: visual.width,
      height: visual.height,
      kind: visual.kind,
    })));
    const response = await fetch("/api/ai/classify-profile-images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artistName, primaryField, images }) });
    if (!response.ok) return pages;
    const result = await response.json() as { classifications?: Array<{ id: string; role: ProfileVisualRole; relevanceScore: number; qualityScore: number; reason: string }> };
    const classifications = new Map((result.classifications ?? []).map((item) => [item.id, item]));
    return pages.map((page) => {
      const extractedVisuals = page.extractedVisuals?.map((visual) => {
        const classification = classifications.get(visual.id);
        if (!classification) return visual;
        return {
          ...visual,
          role: classification.role,
          relevanceScore: classification.relevanceScore,
          qualityScore: classification.qualityScore,
          classificationReason: classification.reason,
          selected: classification.role !== "exclude" && classification.relevanceScore >= 0.55 && classification.qualityScore >= 0.5,
        };
      });
      return { ...page, selected: page.selected || Boolean(extractedVisuals?.some((visual) => visual.selected)), extractedVisuals };
    });
  } catch {
    return pages;
  }
}

type FreeResearchSource = "namuwiki" | "otr" | "showgle";

const freeResearchSources: Array<{ key: FreeResearchSource; label: string; domain: string; verificationTier: "platform" | "reference" }> = [
  { key: "namuwiki", label: "나무위키", domain: "namu.wiki", verificationTier: "reference" },
  { key: "otr", label: "OTR", domain: "otr.co.kr", verificationTier: "platform" },
  { key: "showgle", label: "쇼글", domain: "showgle.co.kr", verificationTier: "platform" },
];

const fields = ["보컬", "연주", "국악", "무용", "퍼포먼스", "마술", "진행·MC", "복합예술", "전통예술", "기타"];
const strengths = ["전문적인 실력", "관객과의 소통", "밝고 즐거운 분위기", "감성적인 분위기", "입장하고 화려한 무대", "전통과 현대의 조화", "가족 모두가 즐길 수 있음", "교육적 요소", "독특한 콘셉트"];
const experiences = ["기업행사", "공공기관 행사", "지역축제", "학교 행사", "문화재단 공연", "거리공연", "방송·미디어", "해외공연", "아직 공식 경력은 많지 않음"];
const impressions = ["실력이 뛰어나다", "믿을 수 있다", "행사를 잘 이해한다", "관객 반응이 좋다", "밝고 친근하다", "고급스럽다", "독창적이다", "전통성이 있다", "급한 일정에도 대응할 수 있다"];
const steps = ["자료 넣기", "내용 확인", "PPT 완성"];
const photoMenuGuides: Array<{ number: number; title: string; description: string; category?: ProfileImageCategory }> = [
  { number: 1, title: "대표사진", description: "표지에 사용할 얼굴과 분위기가 선명한 세로 사진" },
  { number: 2, title: "주요 활동사진", description: "가장 대표적인 공연·전시·창작 활동 장면", category: "activity" },
  { number: 3, title: "공연·전시 전경", description: "무대 규모와 전체 구성이 보이는 가로 사진", category: "activity" },
  { number: 4, title: "관객·현장 반응", description: "관객 호응과 현장 분위기가 함께 보이는 사진", category: "activity" },
  { number: 5, title: "포스터·홍보물", description: "대표 공연·전시의 공식 포스터 또는 홍보 이미지", category: "poster" },
  { number: 6, title: "연혁 자료", description: "주요 활동 흐름을 보여주는 연혁·프로그램북 이미지", category: "history" },
  { number: 7, title: "수상·보도 자료", description: "수상 증빙, 언론 기사 또는 공식 선정 자료", category: "history" },
  { number: 8, title: "디테일·추가 활동사진", description: "연주·작품·의상 디테일 또는 다른 대표 활동", category: "activity" },
];

function normalizeField(value: string) {
  const keywordMap: Array<[string, string]> = [
    ["보컬|가수|성악|노래", "보컬"], ["연주|밴드|악기|오케스트라", "연주"], ["국악|판소리|민요", "국악"],
    ["무용|댄스|춤", "무용"], ["마술|매직", "마술"], ["MC|사회|진행", "진행·MC"], ["전통", "전통예술"],
    ["퍼포먼스|공연", "퍼포먼스"], ["복합|융복합", "복합예술"],
  ];
  return keywordMap.find(([pattern]) => new RegExp(pattern, "i").test(value))?.[1] ?? (fields.includes(value) ? value : "기타");
}

function itemsToCareers(items: ExtractedItem[]) {
  return items
    .filter((item) => ["career", "performance", "award", "media"].includes(item.type))
    .map((item) => {
      const year = item.value.match(/(?:19|20)\d{2}(?:[.년\-/]\d{1,2})?(?:[.월\-/]\d{1,2})?/)?.[0] ?? "";
      return {
        id: crypto.randomUUID(),
        year,
        title: item.value.replace(year, "").replace(/^\s*[·.\-/]\s*/, "").trim(),
        organization: item.pageNumber ? `${item.label} · ${item.pageNumber}p` : item.label,
        sourceName: item.sourceName,
        sourceUrl: item.sourceUrl,
        verificationTier: item.verificationTier,
      };
    });
}

function mergeExtractedItems(...groups: ExtractedItem[][]) {
  const seen = new Set<string>();
  return groups.flat().filter((item) => {
    const key = `${item.type}:${item.value.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;
    if (!item.value.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toggleInList(list: string[], value: string, limit = 99) {
  if (list.includes(value)) return list.filter((item) => item !== value);
  return list.length >= limit ? list : [...list, value];
}

function approvedWebImage(candidate: WebImageCandidate): ExternalImageAsset {
  return {
    id: crypto.randomUUID(),
    dataUrl: candidate.dataUrl,
    source: candidate.source,
    sourceUrl: candidate.sourceUrl,
    title: candidate.title,
    relevanceScore: candidate.relevanceScore,
    qualityScore: candidate.qualityScore,
    visualRole: candidate.visualRole,
    identityScore: candidate.identityScore,
    visualMatchScore: candidate.visualMatchScore,
    identityReason: candidate.reason,
    referenceSignals: candidate.referenceSignals,
    watermarkDetected: candidate.watermarkDetected,
    usageStatus: "approved",
  };
}

export default function ProfileStudio() {
  const { config: siteConfig } = useSiteSettings();
  const [profile, setProfile] = useState<ProfileData>(initialProfile);
  const [step, setStep] = useState(0);
  const [pdfName, setPdfName] = useState("");
  const [pdfProgress, setPdfProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [aiStatus, setAiStatus] = useState<AiStatus>({ configured: false, provider: "확인 중", model: "" });
  const template = useMemo(() => getTemplate(profile.templateKey), [profile.templateKey]);

  useEffect(() => {
    void loadProfileDraft()
      .then((saved) => { if (saved) setProfile({ ...initialProfile, ...saved }); })
      .catch(() => { /* 새 초안으로 계속 진행 */ });
  }, []);

  useEffect(() => {
    void fetch("/api/ai/status")
      .then((response) => response.json())
      .then((status: AiStatus) => setAiStatus(status))
      .catch(() => setAiStatus({ configured: false, provider: "기본 OCR", model: "로컬 분석" }));
  }, []);

  useEffect(() => {
    if (profile.source) void saveProfileDraft(profile).catch(() => setNotice("초안 저장 공간이 부족합니다. 불필요한 이미지를 줄여주세요."));
  }, [profile]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  const update = <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => setProfile((current) => ({ ...current, [key]: value }));

  const uploadPptx = async (file: File) => {
    if (file.size > 40 * 1024 * 1024) return setNotice("PPTX는 최대 40MB까지 업로드할 수 있어요.");
    setBusy(true); setPdfName(file.name); setPdfProgress(18); setNotice("기존 PPTX에서 문구와 사진을 자동 분리하고 있어요.");
    const timer = window.setInterval(() => setPdfProgress((value) => Math.min(value + 10, 82)), 260);
    try {
      const body = new FormData(); body.append("file", file);
      const response = await fetch("/api/pptx/extract", { method: "POST", body });
      const data = await response.json() as PptxUploadResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "PPTX 분석에 실패했습니다.");
      setPdfProgress(86); setNotice("AI가 PPTX의 연혁·수상·활동과 사용할 사진을 자동 정리하고 있어요.");
      let finalItems = inferItemsFromText(data.text);
      let aiProfile: AiExtractionResponse["profile"] | undefined;
      let provider = data.mode === "ai" ? "Gemini" : "기본 이미지 분석";
      try {
        const pages = data.images.map((image, index) => ({ pageNumber: image.slideNumbers[0] || index + 1, previewDataUrl: image.dataUrl, text: "", textSource: "none" as const }));
        const aiResponse = await fetch("/api/ai/extract-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: data.text, pages }) });
        const aiResult = await aiResponse.json() as Partial<AiExtractionResponse>;
        if (aiResponse.ok && aiResult.profile && aiResult.items) {
          aiProfile = aiResult.profile;
          finalItems = mergeExtractedItems(aiResult.items, finalItems);
          provider = aiResult.provider === "gemini" ? "Gemini" : "OpenAI";
        }
      } catch { /* 문서 기본 추출 결과로 계속 진행합니다. */ }

      const extractedCareers = aiProfile?.facts?.length ? aiProfile.facts.map((fact) => ({ id: crypto.randomUUID(), year: fact.date, title: fact.title || fact.description, organization: [fact.organization, fact.location, fact.pageNumber ? `${fact.pageNumber}슬라이드` : ""].filter(Boolean).join(" · ") })) : itemsToCareers(finalItems);
      const uniqueCareers = extractedCareers.filter((career, index, list) => career.title.trim() && list.findIndex((target) => `${target.year}:${target.title}` === `${career.year}:${career.title}`) === index);
      const representative = data.images.find((image) => image.role === "representative") || data.images[0];
      const activityImages = data.images.filter((image) => image !== representative).slice(0, FILE_LIMITS.maxPerformanceImages);
      const categoryMap = { representative: "activity", activity: "activity", poster: "poster", history: "history" } as const;
      const earliestYear = uniqueCareers.map((career) => career.year.match(/(?:19|20)\d{2}/)?.[0]).filter((year): year is string => Boolean(year)).sort()[0] || "";
      setProfile((current) => ({
        ...current,
        source: "pdf",
        artistName: aiProfile?.artistName || finalItems.find((item) => item.type === "artist_name")?.value || current.artistName,
        artistType: aiProfile?.artistType && aiProfile.artistType !== "알 수 없음" ? aiProfile.artistType : current.artistType,
        primaryField: aiProfile?.primaryField ? normalizeField(aiProfile.primaryField) : current.primaryField || "기타",
        secondaryField: aiProfile?.secondaryFields.join(", ") || current.secondaryField,
        region: aiProfile?.region || current.region,
        members: aiProfile?.members.join(", ") || current.members,
        contact: aiProfile?.contacts.join(" · ") || current.contact,
        officialUrl: aiProfile?.socialLinks[0] || current.officialUrl,
        videoUrl: aiProfile?.socialLinks.find((link) => isYouTubeVideoUrl(link)) || current.videoUrl,
        introduction: aiProfile?.introduction || current.introduction,
        tagline: aiProfile?.tagline || current.tagline,
        generatedStrengths: aiProfile?.strengths || current.generatedStrengths,
        activeSince: current.activeSince || earliestYear,
        identityHint: current.identityHint || (uniqueCareers[0] ? [uniqueCareers[0].year, uniqueCareers[0].title, uniqueCareers[0].organization].filter(Boolean).join(" · ") : ""),
        careers: uniqueCareers.length ? uniqueCareers : current.careers,
        extractedItems: finalItems,
        representativeImage: representative?.dataUrl || current.representativeImage,
        performanceImages: activityImages.map((image) => image.dataUrl),
        performanceImageCategories: activityImages.map((image) => categoryMap[image.role]),
      }));
      setPdfProgress(100);
      setNotice(`${provider}가 ${data.slideCount}장 PPTX를 분석해 정보 ${finalItems.length}개와 사용할 이미지 ${data.selectedImageCount}장을 자동 선택했습니다.`);
      window.setTimeout(() => setStep(1), 350);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PPTX 분석에 실패했습니다.");
      setPdfProgress(0);
    } finally { window.clearInterval(timer); setBusy(false); }
  };

  const uploadPdf = async (file?: File) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setNotice("PDF 파일만 업로드할 수 있어요.");
    if (file.size > FILE_LIMITS.pdf) return setNotice("PDF는 최대 30MB까지 업로드할 수 있어요.");
    setBusy(true); setPdfName(file.name); setPdfProgress(18); setNotice("");
    const timer = window.setInterval(() => setPdfProgress((value) => Math.min(value + 12, 86)), 220);
    try {
      let data: PdfUploadResponse;
      let serverErrorMessage = "";
      try {
        const body = new FormData(); body.append("file", file);
        const response = await fetch(process.env.NEXT_PUBLIC_PDF_ANALYSIS_ENDPOINT || "/api/pdf/extract", { method: "POST", body });
        const serverData = await response.json().catch(() => ({ error: "서버 응답을 읽지 못했습니다." }));
        if (!response.ok) throw new Error(serverData.error);
        data = { ...serverData, analysisMode: "server" } as PdfUploadResponse;
      } catch (serverError) {
        serverErrorMessage = serverError instanceof Error ? serverError.message : "서버 분석에 실패했습니다.";
        clearInterval(timer);
        setNotice("서버 분석이 어려워 브라우저에서 안전하게 다시 분석하고 있어요.");
        setPdfProgress(35);
        try {
          const browserData = await analyzePdfInBrowser(file, (progress) => setPdfProgress(progress));
          data = {
            ...browserData,
            text: browserData.combinedText,
            items: inferItemsFromText(browserData.combinedText),
            analysisMode: "browser",
          };
        } catch (browserError) {
          const browserMessage = browserError instanceof Error ? browserError.message : "브라우저 분석도 완료하지 못했습니다.";
          throw new Error(`${serverErrorMessage} 브라우저 재분석 실패: ${browserMessage}`);
        }
      }
      let finalItems = mergeExtractedItems(data.items, inferItemsFromText(data.text));
      let aiProfile: AiExtractionResponse["profile"] | undefined;
      let aiMode = false;
      let aiProvider = "";
      let aiModel = "";
      setPdfProgress(90);
      setNotice("AI가 PDF 이미지와 원문을 함께 읽고 연혁·공연·수상을 정리하고 있어요.");
      try {
        const aiBody = new FormData();
        aiBody.append("file", file);
        aiBody.append("text", data.text || data.pages.map((page) => `[${page.pageNumber}페이지]\n${page.text}`).join("\n\n"));
        const response = await fetch("/api/ai/extract-profile", {
          method: "POST",
          body: aiBody,
        });
        const result = await response.json().catch(() => ({})) as Partial<AiExtractionResponse> & { code?: string };
        if (response.ok && result.items && result.profile) {
          finalItems = mergeExtractedItems(result.items, finalItems);
          aiProfile = result.profile;
          aiMode = true;
          aiProvider = result.provider === "gemini" ? "Gemini" : "OpenAI";
          aiModel = result.model || "";
        }
      } catch {
        // AI 호출이 실패해도 OCR·규칙 기반 결과로 계속 진행합니다.
      }
      const name = aiProfile?.artistName || finalItems.find((item) => item.type === "artist_name")?.value;
      if (aiProfile?.visualRegions?.length) data.pages = await cropAiVisualRegions(data.pages, aiProfile.visualRegions);
      data.pages = await classifyDocumentVisuals(data.pages, name || profile.artistName, aiProfile?.primaryField || profile.primaryField);
      const aiCareers = aiProfile?.facts?.length
        ? aiProfile.facts.map((fact) => ({
            id: crypto.randomUUID(),
            year: fact.date,
            title: fact.title || fact.description,
            organization: [fact.organization, fact.location, fact.pageNumber ? `${fact.pageNumber}p` : ""].filter(Boolean).join(" · "),
          }))
        : [];
      const careerKeys = new Set<string>();
      const careers = [...aiCareers, ...itemsToCareers(finalItems)].filter((career) => {
        const key = `${career.year}:${career.title.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;
        if (!career.title.trim() || careerKeys.has(key)) return false;
        careerKeys.add(key);
        return true;
      });
      const earliestActivityYear = careers.map((career) => career.year.match(/(?:19|20)\d{2}/)?.[0]).filter((year): year is string => Boolean(year)).sort()[0] || "";
      const representativeCareerHint = careers.find((career) => career.title.trim());
      const separatedVisualCount = data.pages.reduce((count, page) => count + (page.extractedVisuals?.length ?? 0), 0);
      const autoRepresentative = data.pages
        .flatMap((page) => (page.extractedVisuals ?? []).filter((visual) => visual.selected))
        .sort((left, right) => Number(right.role === "portrait") - Number(left.role === "portrait") || Number(right.role === "stage") - Number(left.role === "stage") || (right.qualityScore ?? 0) - (left.qualityScore ?? 0))[0]?.dataUrl;
      setProfile((current) => ({
        ...current,
        artistName: name || current.artistName,
        artistType: aiProfile?.artistType && aiProfile.artistType !== "알 수 없음" ? aiProfile.artistType : current.artistType,
        primaryField: aiProfile?.primaryField ? normalizeField(aiProfile.primaryField) : current.primaryField,
        secondaryField: aiProfile?.secondaryFields.join(", ") || current.secondaryField,
        region: aiProfile?.region || current.region,
        activeSince: current.activeSince || earliestActivityYear,
        identityHint: current.identityHint || (representativeCareerHint ? [representativeCareerHint.year, representativeCareerHint.title, representativeCareerHint.organization].filter(Boolean).join(" · ") : ""),
        officialUrl: current.officialUrl || aiProfile?.socialLinks[0] || "",
        members: aiProfile?.members.join(", ") || current.members,
        contact: aiProfile?.contacts.join(" · ") || current.contact,
        videoUrl: aiProfile?.socialLinks[0] || current.videoUrl,
        introduction: aiProfile?.introduction || current.introduction,
        tagline: aiProfile?.tagline || current.tagline,
        generatedStrengths: aiProfile?.strengths || current.generatedStrengths,
        representativeImage: current.representativeImage || autoRepresentative,
        careers: careers.length ? careers : current.careers,
        extractedItems: finalItems,
        pdfPageAssets: data.pages || [],
      }));
      setNotice(aiMode
        ? `${aiProvider} · ${aiModel} 원본 PDF 정밀 분석 완료: ${finalItems.length}개 정보와 PPT용 사진·그림 ${separatedVisualCount}개를 분리했어요. 원문과 대조해 승인해 주세요.`
        : data.warnings?.length
        ? `PDF를 부분 분석했습니다. ${data.warnings[0]}`
        : data.analysisMode === "browser"
          ? "서버 대신 브라우저에서 PDF 분석을 완료했어요. 페이지 이미지와 OCR 결과를 확인해 주세요."
        : data.ocrPageCount > 0
          ? `이미지형 ${data.ocrPageCount}개 페이지를 OCR로 읽었어요. AI 키를 연결하면 페이지 이미지까지 정밀 분석합니다.`
          : "기본 분석을 완료했어요. AI 키를 연결하면 연혁과 고유명사를 더 정밀하게 분류합니다.");
      setPdfProgress(100);
      setTimeout(() => setStep(1), 450);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF 분석에 실패했습니다.");
      setPdfProgress(0);
    } finally { clearInterval(timer); setBusy(false); }
  };

  const uploadImage = (event: ChangeEvent<HTMLInputElement>, representative = false, category: ProfileImageCategory = "activity", targetIndex?: number) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    files.forEach((file) => {
      if (!file.type.startsWith("image/") || file.size > FILE_LIMITS.image) return;
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result);
        if (representative) update("representativeImage", value);
        else setProfile((current) => {
          const images = [...current.performanceImages];
          const categories = [...(current.performanceImageCategories ?? [])];
          const index = targetIndex ?? images.length;
          const replacing = Boolean(images[index]);
          const totalCount = images.filter(Boolean).length + (current.externalImages?.length ?? 0);
          if (!replacing && totalCount >= FILE_LIMITS.maxPerformanceImages) return current;
          while (images.length <= index) images.push("");
          while (categories.length <= index) categories.push("activity");
          images[index] = value;
          categories[index] = category;
          return {
            ...current,
            performanceImages: images,
            performanceImageCategories: categories,
          };
        });
      };
      reader.readAsDataURL(file);
    });
  };

  const uploadQuickMaterials = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const pptx = files.find((file) => file.name.toLowerCase().endsWith(".pptx") || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    update("source", files.some((file) => file.type === "application/pdf" || /\.(?:pdf|pptx)$/i.test(file.name)) ? "pdf" : "questionnaire");
    const pdf = files.find((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    const images = files.filter((file) => file.type.startsWith("image/") && file.size <= FILE_LIMITS.image);
    images.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result);
        setProfile((current) => {
          if (!current.representativeImage) return { ...current, representativeImage: value };
          const performanceImages = [...current.performanceImages];
          const performanceImageCategories = [...current.performanceImageCategories];
          if (performanceImages.filter(Boolean).length + current.externalImages.length >= FILE_LIMITS.maxPerformanceImages) return current;
          performanceImages.push(value);
          performanceImageCategories.push("activity");
          return { ...current, performanceImages, performanceImageCategories };
        });
      };
      reader.readAsDataURL(file);
    });
    if (pptx) void uploadPptx(pptx);
    else if (pdf) void uploadPdf(pdf);
    else {
      setNotice(`${images.length}장의 사진을 등록했어요. 대표사진과 활동사진을 자동으로 나눴습니다.`);
      setStep(1);
    }
  };

  const analyzeQuickLinks = async (rawLinks: string) => {
    const candidates = rawLinks.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    const parsedLinks = [...new Set(candidates.map((candidate) => {
      try {
        const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
      } catch {
        return "";
      }
    }).filter(Boolean))].slice(0, 8);
    if (!parsedLinks.length) {
      setNotice("한 줄에 하나씩 올바른 외부 링크를 입력해 주세요.");
      return;
    }

    const videoLinks = parsedLinks.filter(isYouTubeVideoUrl);
    const profileLinks = parsedLinks.filter((url) => !isYouTubeVideoUrl(url));
    setBusy(true);
    setNotice(`${parsedLinks.length}개 링크를 확인하고 있어요. 외부 원문은 함께 읽고 AI 분석은 한 번만 실행합니다.`);
    try {
      const results = await Promise.all(profileLinks.map(async (url) => {
        try {
          const response = await fetch("/api/profile-link/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          const page = await response.json() as ProfileLinkResponse;
          if (!response.ok) throw new Error(page.error || "원문을 읽지 못했습니다.");
          return { requestedUrl: url, page };
        } catch (error) {
          return { requestedUrl: url, error: error instanceof Error ? error.message : "원문을 읽지 못했습니다." };
        }
      }));
      const pages = results.flatMap((result) => result.page ? [result.page] : []);
      const nonAmbiguousPages = pages.filter((page) => !(page.verificationTier === "reference" && /분류\s*동음이의어/.test(page.text.slice(0, 3_000))));
      const identitySignals = [profile.artistName, profile.affiliation]
        .map((value) => value.replace(/\s+/g, "").toLowerCase())
        .filter((value) => value.length >= 2);
      const usablePages = nonAmbiguousPages.filter((page) => {
        if (!identitySignals.length) return true;
        const sourceText = `${page.title}\n${page.text}`.replace(/\s+/g, "").toLowerCase();
        return identitySignals.some((signal) => sourceText.includes(signal));
      });
      const ambiguousCount = pages.length - nonAmbiguousPages.length;
      const unrelatedCount = nonAmbiguousPages.length - usablePages.length;

      const pageForValue = (value: string) => {
        const normalized = value.toLowerCase();
        const direct = usablePages.find((page) => normalized.includes(page.url.toLowerCase()));
        if (direct) return direct;
        const tokens = normalized.match(/[가-힣a-z0-9]{3,}/g)?.filter((token) => !/^(?:19|20)\d{2}$/.test(token)).slice(0, 10) ?? [];
        return usablePages
          .map((page) => ({ page, score: tokens.filter((token) => page.text.toLowerCase().includes(token)).length }))
          .sort((a, b) => b.score - a.score)[0]?.page ?? usablePages[0];
      };
      const sourceLinkItems: ExtractedItem[] = parsedLinks.map((url) => {
        const page = pages.find((item) => item.url === url) ?? pages.find((item) => item.url.replace(/\/$/, "") === url.replace(/\/$/, ""));
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        const sourceName = isYouTubeVideoUrl(url) ? "YouTube" : page?.sourceName || hostname;
        return {
          id: `social_link-${crypto.randomUUID()}`,
          type: "social_link",
          label: `${sourceName} 원문`,
          value: url,
          confidence: 1,
          status: "approved",
          sourceName,
          sourceUrl: url,
          verificationTier: page?.verificationTier || (isYouTubeVideoUrl(url) ? "platform" : "primary"),
        };
      });
      const localItems: ExtractedItem[] = usablePages.flatMap((page) => inferItemsFromText(page.text)
        .filter((item) => ["career", "performance", "award", "media", "contact"].includes(item.type))
        .map((item) => ({
          ...item,
          confidence: Math.min(item.confidence, 0.65),
          status: "needs_review" as const,
          sourceName: page.sourceName,
          sourceUrl: page.url,
          verificationTier: page.verificationTier,
        })));
      let finalItems = mergeExtractedItems(sourceLinkItems, localItems);
      let aiProfile: AiExtractionResponse["profile"] | undefined;
      let provider = "기본 분석";

      if (usablePages.length) try {
        const perPageLimit = Math.max(12_000, Math.floor(150_000 / usablePages.length));
        const combinedText = [
          `[분석 대상 활동명: ${profile.artistName || "미입력"}]`,
          `[활동 분야: ${profile.primaryField || "미입력"}]`,
          `[소속·지역·식별 단서: ${[profile.affiliation, profile.region, profile.identityHint].filter(Boolean).join(" · ") || "미입력"}]`,
          "아래 여러 원문을 교차 확인하세요. 동명이인, 광고, 사이트 메뉴는 제외하고 대상과 일치하는 사실만 추출하세요.",
          ...usablePages.map((page, index) => `\n[원문 ${index + 1} · ${page.sourceName}]\n[URL: ${page.url}]\n${page.text.slice(0, perPageLimit)}`),
        ].join("\n");
        const aiResponse = await fetch("/api/ai/extract-profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: combinedText }),
        });
        const aiResult = await aiResponse.json() as Partial<AiExtractionResponse>;
        if (aiResponse.ok && aiResult.items && aiResult.profile) {
          aiProfile = aiResult.profile;
          const sourcedAiItems = aiResult.items.map((item) => {
            const source = pageForValue(item.value);
            return { ...item, sourceName: source?.sourceName, sourceUrl: source?.url, verificationTier: source?.verificationTier };
          });
          finalItems = mergeExtractedItems(sourceLinkItems, sourcedAiItems, localItems);
          provider = aiResult.provider === "gemini" ? "Gemini" : "OpenAI";
        }
      } catch {
        // AI 무료 한도가 소진되어도 모든 링크와 규칙 기반 결과는 보존합니다.
      }

      const sourcedCareers = (aiProfile?.facts?.length
        ? aiProfile.facts.map((fact) => {
            const source = pageForValue([fact.title, fact.organization, fact.location, fact.description].join(" "));
            return {
              id: crypto.randomUUID(),
              year: fact.date,
              title: fact.title || fact.description,
              organization: [fact.organization, fact.location].filter(Boolean).join(" · "),
              sourceName: source?.sourceName,
              sourceUrl: source?.url,
              verificationTier: source?.verificationTier,
            };
          })
        : itemsToCareers(finalItems)).filter((career) => career.title.trim());

      setProfile((current) => {
        const careerKeys = new Set(current.careers.filter((career) => career.title.trim()).map((career) => `${career.year}:${career.title.replace(/\s+/g, " ").toLowerCase()}`));
        const newCareers = sourcedCareers.filter((career) => {
          const key = `${career.year}:${career.title.replace(/\s+/g, " ").toLowerCase()}`;
          if (careerKeys.has(key)) return false;
          careerKeys.add(key);
          return true;
        });
        const existingCareers = current.careers.filter((career) => career.title.trim());
        const firstCareer = newCareers[0] || existingCareers[0];
        return {
          ...current,
          source: current.source || "questionnaire",
          artistName: current.artistName || aiProfile?.artistName || "",
          artistType: aiProfile?.artistType && aiProfile.artistType !== "알 수 없음" ? aiProfile.artistType : current.artistType,
          primaryField: current.primaryField || (aiProfile?.primaryField ? normalizeField(aiProfile.primaryField) : ""),
          secondaryField: current.secondaryField || aiProfile?.secondaryFields.join(", ") || "",
          region: current.region || aiProfile?.region || "",
          members: current.members || aiProfile?.members.join(", ") || "",
          contact: current.contact || aiProfile?.contacts.join(" · ") || "",
          officialUrl: current.officialUrl || profileLinks[0] || "",
          videoUrl: current.videoUrl || (videoLinks[0] ? normalizeVideoUrl(videoLinks[0]) : "") || aiProfile?.socialLinks.find(isYouTubeVideoUrl) || "",
          introduction: current.introduction || aiProfile?.introduction || "",
          tagline: current.tagline || aiProfile?.tagline || "",
          generatedStrengths: current.generatedStrengths.length ? current.generatedStrengths : aiProfile?.strengths || [],
          identityHint: current.identityHint || (firstCareer ? [firstCareer.year, firstCareer.title, firstCareer.organization].filter(Boolean).join(" · ") : usablePages[0]?.title || ""),
          careers: [...existingCareers, ...newCareers].length ? [...existingCareers, ...newCareers] : current.careers,
          extractedItems: mergeExtractedItems(current.extractedItems, finalItems),
        };
      });

      const failedCount = results.filter((result) => result.error).length;
      const details = [
        `${parsedLinks.length}개 링크 저장`,
        `${usablePages.length}개 원문 분석`,
        videoLinks.length ? `YouTube ${videoLinks.length}개` : "",
        ambiguousCount ? `동음이의어 ${ambiguousCount}개 제외` : "",
        unrelatedCount ? `활동명 불일치 ${unrelatedCount}개 제외` : "",
        failedCount ? `자동 읽기 제한 ${failedCount}개` : "",
      ].filter(Boolean).join(" · ");
      setNotice(`${provider} 완료: ${details}. 경력·수상·공연 ${sourcedCareers.length}건을 반영했어요.`);
    } finally {
      setBusy(false);
    }
  };

  const generateCopy = async () => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/ai/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(profile) });
      const data = await response.json();
      setProfile((current) => ({ ...current, tagline: data.tagline, introduction: data.introduction, generatedStrengths: data.strengths }));
      setNotice(data.mode === "ai" ? "입력한 자료를 바탕으로 AI 문구를 작성했어요." : "입력한 자료만 사용해 안전한 초안을 작성했어요.");
    } catch { setNotice("문구 생성 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };

  const exportDeck = async () => {
    setBusy(true);
    setNotice("Gemini가 사진의 역할과 페이지 흐름을 설계하고 PPTX를 제작하고 있어요.");
    try {
      const result = await downloadPptx(profile);
      setNotice(result.mode === "ai"
        ? `${result.provider} · ${result.model}이 사진을 선별하고 ${result.slideCount}페이지 PPTX를 구성했어요.`
        : `AI 기획을 사용할 수 없어 기본 구성으로 ${result.slideCount}페이지 PPTX를 만들었어요.`);
    } catch {
      setNotice("PPTX 제작 중 문제가 생겼습니다. 이미지 용량을 줄이거나 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const prepareDeck = async () => {
    setBusy(true);
    setNotice("기존 PDF·PPTX 이미지와 승인 가능한 웹 사진을 먼저 모으고 PPT 초안을 만들고 있어요.");
    try {
      let workingProfile = profile.primaryField.trim() ? profile : { ...profile, primaryField: "기타" };
      if (workingProfile.templateMode !== "manual") workingProfile = { ...workingProfile, templateMode: "auto", templateKey: recommendTemplateKey(workingProfile) };
      let addedWebImageCount = 0;
      const existingAssets = selectPortfolioAssets(collectDeckAssets(workingProfile), 24);
      const desiredVisualCount = Math.min(8, Math.max(5, workingProfile.pageCount));
      const pdfReference = workingProfile.pdfPageAssets
        .flatMap((page) => page.selected ? (page.extractedVisuals ?? []).filter((visual) => visual.selected) : [])
        .sort((a, b) => Number(b.role === "portrait") - Number(a.role === "portrait") || Number(b.role === "stage") - Number(a.role === "stage") || Number(b.kind === "photo") - Number(a.kind === "photo"))[0]?.dataUrl;
      const referenceImageSource = workingProfile.representativeImage || workingProfile.performanceImages.find(Boolean) || pdfReference;
      if (workingProfile.artistName.trim() && referenceImageSource && existingAssets.length < desiredVisualCount) {
        try {
          const referenceImage = await makeImageThumbnail(referenceImageSource, 768);
          const response = await fetch("/api/ai/search-artist-images", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ artistName: workingProfile.artistName, primaryField: workingProfile.primaryField, region: workingProfile.region, affiliation: workingProfile.affiliation, activeSince: workingProfile.activeSince, identityHint: workingProfile.identityHint, officialUrl: workingProfile.officialUrl, careers: workingProfile.careers, referenceImage }),
          });
          const result = await response.json() as { candidates?: WebImageCandidate[] };
          if (response.ok) {
            const existingUrls = new Set(workingProfile.externalImages.map((image) => image.sourceUrl).filter(Boolean));
            const remaining = Math.max(0, FILE_LIMITS.maxPerformanceImages - workingProfile.performanceImages.filter(Boolean).length - workingProfile.externalImages.length);
            const additions: ExternalImageAsset[] = (result.candidates ?? [])
              .filter((candidate) => candidate.recommended && candidate.usageStatus === "approved" && !candidate.watermarkDetected && !existingUrls.has(candidate.sourceUrl))
              .slice(0, Math.min(4, remaining, desiredVisualCount - existingAssets.length))
              .map(approvedWebImage);
            if (additions.length) {
              workingProfile = { ...workingProfile, externalImages: [...workingProfile.externalImages, ...additions] };
              addedWebImageCount = additions.length;
            }
          }
        } catch {
          // 웹 검색이 실패해도 사용자 자료와 PDF·PPTX에서 분리한 이미지를 우선 사용합니다.
        }
      }
      if (!workingProfile.introduction.trim()) {
        try {
          const response = await fetch("/api/ai/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workingProfile) });
          const copy = await response.json();
          if (response.ok) workingProfile = { ...workingProfile, tagline: copy.tagline || workingProfile.tagline, introduction: copy.introduction || workingProfile.introduction, generatedStrengths: copy.strengths || workingProfile.generatedStrengths };
        } catch {
          // 문구 보완이 실패해도 현재 자료로 PPT 초안을 계속 만듭니다.
        }
      }
      const prepared = await prepareDeckPlan(workingProfile);
      setProfile({ ...workingProfile, pageCount: prepared.plan.slides.length, deckPlan: prepared.plan, deckPlanMeta: prepared.meta });
      setNotice(prepared.meta.mode === "ai"
        ? `${prepared.meta.provider} · ${prepared.meta.model}이 ${prepared.plan.slides.length}페이지를 고객 제안형으로 구성했어요.${addedWebImageCount ? ` 검수된 웹 사진 ${addedWebImageCount}장 자동 추가 ·` : ""} 품질 검사 ${prepared.meta.qualityScore ?? 90}점 · 근거 ${prepared.meta.coveredFactCount ?? 0}/${prepared.meta.totalFactCount ?? 0}개 반영 · 사진 반복과 텍스트 이탈 금지 적용.`
        : `${prepared.meta.warning || "Gemini 기획을 완료하지 못했습니다."} 기본 페이지 구성으로 미리보기를 만들었어요. (오류 코드: ${prepared.meta.errorCode || "DECK_PLANNING_FAILED"})`);
      setStep(2);
    } catch {
      setNotice("PPT 페이지 기획 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const resetDraft = () => {
    void clearProfileDraft(); setProfile(initialProfile); setStep(0); setPdfName(""); setNotice("");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setStep(0)} aria-label="홈으로"><span className="brand-mark">{siteConfig.brand.mark}</span><span>{siteConfig.brand.name}</span></button>
        <nav><button>{siteConfig.navigation.studio}</button><Link href="/team">{siteConfig.navigation.team}</Link><Link href="/admin/design-templates">{siteConfig.navigation.admin}</Link><button onClick={resetDraft}>{siteConfig.navigation.newProject}</button></nav>
        <button className="icon-button"><Menu size={20} /></button>
      </header>

      {step > 0 && (
        <div className="progress-wrap">
          <button className="back-link" onClick={() => setStep(Math.max(0, step - 1))}><ArrowLeft size={16} /> 이전</button>
          <div className="progress-steps">
            {steps.map((label, index) => <div key={label} className={`progress-item ${index <= step ? "active" : ""}`}><span>{index < step ? <Check size={12} /> : index + 1}</span><small>{label}</small></div>)}
          </div>
          <span className="autosave"><CheckCircle2 size={14} /> 자동 저장됨</span>
        </div>
      )}

      {step === 0 && <QuickStartStep profile={profile} update={update} progress={pdfProgress} fileName={pdfName} busy={busy} notice={notice} aiStatus={aiStatus} onUpload={uploadQuickMaterials} onAnalyzeLinks={analyzeQuickLinks} onSkip={() => { update("source", "questionnaire"); setStep(1); }} />}
      {step === 1 && <QuickReviewStep profile={profile} update={update} setProfile={setProfile} uploadImage={uploadImage} busy={busy} notice={notice} generate={generateCopy} onBuild={prepareDeck} />}
      {step === 2 && <PreviewStep profile={profile} template={template} busy={busy} notice={notice} onEdit={() => setStep(1)} onRetry={prepareDeck} onDownload={exportDeck} />}
    </main>
  );
}

function QuickStartStep({ profile, update, progress, fileName, busy, notice, aiStatus, onUpload, onAnalyzeLinks, onSkip }: {
  profile: ProfileData;
  update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void;
  progress: number;
  fileName: string;
  busy: boolean;
  notice: string;
  aiStatus: AiStatus;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onAnalyzeLinks: (links: string) => Promise<void>;
  onSkip: () => void;
}) {
  const { config } = useSiteSettings();
  const [linkValue, setLinkValue] = useState(profile.videoUrl || profile.officialUrl);
  const saveLink = () => {
    const link = linkValue.trim();
    if (!link) return;
    void onAnalyzeLinks(link);
  };
  const sectionContent: Record<string, React.ReactNode> = {
    identity: <div className="quick-identity-row" key="identity"><label><span>활동명 또는 팀명</span><input value={profile.artistName} onChange={(event) => update("artistName", event.target.value)} placeholder="예: 김아트 / 아트앙상블" /></label><label><span>분야</span><select value={profile.primaryField} onChange={(event) => update("primaryField", event.target.value)}><option value="">자료에서 자동 찾기</option>{fields.map((field) => <option key={field}>{field}</option>)}</select></label></div>,
    upload: <label className={`unified-dropzone ${busy ? "busy" : ""}`} key="upload"><input type="file" accept="application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx,image/*" multiple disabled={busy} onChange={onUpload} /><span className="dropzone-icon">{busy ? <Loader2 className="spin" /> : <Upload />}</span><strong>{busy ? "자료를 읽고 있어요" : config.home.uploadTitle}</strong><small>{config.home.uploadDescription}<br />PDF·PPTX 안의 사진과 문구도 AI가 자동 선별합니다.</small></label>,
    link: <div className="quick-link-row" key="link"><label><span>링크가 있다면 여러 개 붙여넣기 <small>최대 8개 · 한 줄에 하나씩</small></span><textarea value={linkValue} onChange={(event) => setLinkValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) saveLink(); }} placeholder={"나무위키·OTR·쇼글·홈페이지·YouTube 링크\nhttps://...\nhttps://..."} /></label><button disabled={busy || !linkValue.trim()} onClick={saveLink}>{busy ? "분석 중" : "모든 링크 분석"}</button></div>,
    aiStatus: <div className="quick-ai-state" key="aiStatus"><CheckCircle2 size={15} /><span>{aiStatus.configured ? `${aiStatus.provider}가 이미지형 PDF와 사진 속 글자까지 분석합니다.` : "AI 한도가 없어도 기본 OCR로 자료를 정리합니다."}</span></div>,
  };
  return <section className="hero quick-start-page">
    <div className="eyebrow"><Sparkles size={14} /> {config.home.eyebrow}</div>
    <h1>{config.home.title}<br /><em>{config.home.accentTitle}</em></h1>
    <p>{config.home.description}</p>
    <div className="quick-start-card">
      {config.home.sections.filter((section) => section.enabled && section.key !== "trust").map((section) => sectionContent[section.key])}
      {progress > 0 && <div className="quick-analysis-progress"><div><span style={{ width: `${progress}%` }} /></div><strong>{fileName || "업로드한 자료"} · {progress}%</strong></div>}
      {notice && <div className="notice warning">{notice}</div>}
    </div>
    <button className="text-start-button" onClick={onSkip}>{profile.officialUrl || profile.videoUrl ? "입력한 링크로 계속하기" : config.home.noMaterialLabel} <ArrowRight size={15} /></button>
    {config.home.sections.find((section) => section.key === "trust")?.enabled && <div className="trust-row">{config.home.trustItems.map((item) => <span key={item}><CheckCircle2 /> {item}</span>)}</div>}
  </section>;
}

function QuickReviewStep({ profile, update, setProfile, uploadImage, busy, notice, generate, onBuild }: {
  profile: ProfileData;
  update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void;
  setProfile: React.Dispatch<React.SetStateAction<ProfileData>>;
  uploadImage: (event: ChangeEvent<HTMLInputElement>, representative?: boolean, category?: ProfileImageCategory, targetIndex?: number) => void;
  busy: boolean;
  notice: string;
  generate: () => void;
  onBuild: () => Promise<void>;
}) {
  const realCareers = profile.careers.filter((career) => career.title.trim() || career.organization.trim());
  const reviewItems = profile.extractedItems.filter((item) => ["career", "performance", "award", "media", "introduction"].includes(item.type)).slice(0, 18);
  const checks = [
    Boolean(profile.artistName.trim()), Boolean(profile.primaryField.trim()), Boolean(profile.representativeImage),
    realCareers.length > 0, Boolean(profile.introduction.trim()), Boolean(profile.contact.trim()),
    profile.performanceImages.filter(Boolean).length > 0, Boolean(profile.videoUrl.trim()),
  ];
  const completeness = Math.round(checks.filter(Boolean).length / checks.length * 100);
  const missing = [
    !profile.representativeImage && "표지에 사용할 대표사진",
    !realCareers.length && "대표 경력 또는 수상 1개",
    !profile.contact.trim() && "섭외 연락처",
    !profile.performanceImages.filter(Boolean).length && "활동사진 1장",
  ].filter((item): item is string => Boolean(item));
  const setItemStatus = (id: string, status: ExtractedItem["status"]) => update("extractedItems", profile.extractedItems.map((item) => item.id === id ? { ...item, status } : item));

  return <section className="stage quick-review-stage">
    <div className="section-heading"><span>02 · 내용 확인</span><h1>앱이 정리한 내용만 확인해 주세요</h1><p>맞는 내용은 그대로 두고, 다른 사람의 기록이나 불필요한 항목만 제외하면 됩니다.</p></div>
    <div className="quick-score-card"><div><span>현재 자료 완성도</span><strong>{completeness}<small>점</small></strong></div><div><div className="score-track"><span style={{ width: `${completeness}%` }} /></div><p>{missing.length ? `${missing.slice(0, 2).join(" · ")} 추가 시 PPT가 더 좋아집니다.` : "현재 자료만으로 완성도 높은 PPT를 만들 수 있어요."}</p></div></div>
    <div className="quick-essential-card"><div className="card-heading"><div><h2>꼭 필요한 정보</h2><p>세 가지만 확인하면 바로 PPT를 만들 수 있습니다.</p></div><span className="required-count">필수 3개</span></div><div className="quick-essential-grid"><label><span>활동명</span><input value={profile.artistName} onChange={(event) => update("artistName", event.target.value)} placeholder="활동명 또는 팀명" /></label><label><span>활동 분야</span><select value={profile.primaryField} onChange={(event) => update("primaryField", event.target.value)}><option value="">선택해 주세요</option>{fields.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>섭외 연락처 <small>나중에 가능</small></span><input value={profile.contact} onChange={(event) => update("contact", event.target.value)} placeholder="이메일 또는 전화번호" /></label></div></div>
    <div className="quick-media-card"><div><div className="quick-cover-photo">{profile.representativeImage ? <img src={profile.representativeImage} alt="대표사진" /> : <ImagePlus />}<label><input type="file" accept="image/*" onChange={(event) => uploadImage(event, true)} />{profile.representativeImage ? "대표사진 바꾸기" : "대표사진 추가"}</label></div><div><h2>사진은 이미 자동으로 정리했습니다</h2><p>기존 PDF·PPTX에서 AI가 대표사진과 활동사진을 골라 모든 페이지에 자동 배치합니다.</p><label className="quick-add-photos"><input type="file" accept="image/*" multiple onChange={(event) => uploadImage(event, false, "activity")} /><Plus size={14} /> 필요한 경우만 사진 추가</label><small>자동 선택 · 대표사진 {profile.representativeImage ? 1 : 0}장 · 활동사진 {profile.performanceImages.filter(Boolean).length}장</small></div></div></div>
    <div className="quick-review-card"><div className="card-heading"><div><h2>찾아낸 경력·수상·공연</h2><p>초록색은 반영, 회색은 제외됩니다.</p></div><span>{reviewItems.length || realCareers.length}개 발견</span></div>{reviewItems.length ? <div className="fact-confirm-list">{reviewItems.map((item) => <article className={item.status === "excluded" ? "excluded" : "approved"} key={item.id}><div><span>{item.type === "award" ? "수상" : item.type === "performance" ? "공연" : item.type === "media" ? "보도" : "경력"}{item.pageNumber ? ` · ${item.pageNumber}p` : ""}</span><strong>{item.value}</strong></div><div><button className={item.status !== "excluded" ? "selected" : ""} onClick={() => setItemStatus(item.id, "approved")}><Check size={13} /> 맞아요</button><button className={item.status === "excluded" ? "selected exclude" : ""} onClick={() => setItemStatus(item.id, "excluded")}><X size={13} /> 제외</button></div></article>)}</div> : <div className="empty-facts"><FileText /><strong>아직 추출된 경력이 없습니다</strong><p>세부 설정에서 경력 한 줄만 추가해도 PPT를 만들 수 있어요.</p></div>}</div>
    {!profile.introduction.trim() && <button className="quick-copy-button" disabled={busy || !profile.artistName.trim()} onClick={generate}>{busy ? <Loader2 className="spin" /> : <WandSparkles />} 자료로 소개문 자동 작성</button>}
    {notice && <div className="notice warning quick-notice">{notice}</div>}
    <details className="advanced-settings"><summary><PenLine size={15} /> 필요한 경우에만 세부 내용 수정 <ChevronRight size={15} /></summary><div><InformationStep profile={profile} update={update} setProfile={setProfile} uploadImage={uploadImage} notice={notice} /><ContentStep profile={profile} update={update} busy={busy} generate={generate} notice={notice} /><DesignStep profile={profile} update={update} /></div></details>
    <div className="quick-build-bar"><div><strong>{profile.artistName || "아티스트"} 프로필 초안</strong><span>사진 선택·문구 압축·페이지 배치는 앱이 자동으로 완성합니다.</span></div><button disabled={busy || !profile.artistName.trim()} onClick={() => void onBuild()}>{busy ? <><Loader2 className="spin" /> PPT 구성 중</> : <>이 정보로 PPT 자동 완성 <ArrowRight size={16} /></>}</button></div>
  </section>;
}

function SourceStep({ onSelect }: { onSelect: (source: SourceType) => void }) {
  return <section className="hero source-page">
    <div className="eyebrow"><Sparkles size={14} /> ARTIST PROFILE STUDIO</div>
    <h1>지금 사용 중인<br /><em>프로필이 있나요?</em></h1>
    <p>가지고 계신 자료에 맞춰 가장 빠르고 정확한 제작 방법을 안내해 드릴게요.</p>
    <div className="source-grid">
      <button className="source-card featured" onClick={() => onSelect("pdf")}><span className="recommended">가장 빠른 방법</span><div className="source-icon"><FileText /></div><h2>기존 프로필이 있어요</h2><p>사용 중인 PDF를 올리면 내용을 정리해 새로운 디자인으로 제작합니다.</p><strong>PDF로 시작하기 <ChevronRight size={17} /></strong></button>
      <button className="source-card" onClick={() => onSelect("questionnaire")}><div className="source-icon"><PenLine /></div><h2>기존 프로필이 없어요</h2><p>간단한 질문에 답하면 소개 문구부터 프로필까지 함께 만들어 드립니다.</p><strong>질문으로 시작하기 <ChevronRight size={17} /></strong></button>
      <button className="source-card" onClick={() => onSelect("unsure")}><div className="source-icon"><CircleHelp /></div><h2>잘 모르겠어요</h2><p>가지고 계신 자료를 알려주시면 가장 알맞은 제작 방법을 추천해 드립니다.</p><strong>자료 확인하기 <ChevronRight size={17} /></strong></button>
    </div>
    <div className="trust-row"><span><CheckCircle2 /> 복잡한 PPT 편집 없이</span><span><CheckCircle2 /> 언제든 수정 가능</span><span><CheckCircle2 /> 실제 PPTX 다운로드</span></div>
  </section>;
}

function PdfStep({ name, progress, busy, notice, aiStatus, onUpload }: { name: string; progress: number; busy: boolean; notice: string; aiStatus: AiStatus; onUpload: (file?: File) => void }) {
  const prevent = (event: DragEvent) => { event.preventDefault(); event.stopPropagation(); };
  return <section className="stage narrow">
    <div className="section-heading"><span>01 · AI 자료 분석</span><h1>기존 PDF 프로필을 올려주세요</h1><p>텍스트형·이미지형 PDF를 함께 읽고 연혁, 공연, 수상, 연락처와 이미지 자산을 정리합니다. 사용하기 전 직접 확인할 수 있어요.</p></div>
    <div className={`notice ${aiStatus.configured ? "success" : "warning"}`}>{aiStatus.configured ? `AI 키 등록됨 · ${aiStatus.provider} · ${aiStatus.model}` : "AI 미연결 · 현재는 OCR 기본 분석만 사용합니다. 배포 환경의 API 키를 확인해 주세요."}</div>
    <label className={`dropzone ${busy ? "loading" : ""}`} onDragEnter={prevent} onDragOver={prevent} onDrop={(event) => { prevent(event); onUpload(event.dataTransfer.files[0]); }}>
      <input type="file" accept="application/pdf" onChange={(event) => onUpload(event.target.files?.[0])} />
      <div className="drop-icon">{busy ? <Loader2 className="spin" /> : <Upload />}</div>
      <h2>{busy ? "프로필을 분석하고 있어요" : "PDF를 이곳에 끌어다 놓으세요"}</h2>
      <p>{name || "또는 클릭하여 파일 선택"}</p>
      {progress > 0 && <div className="upload-progress"><span style={{ width: `${progress}%` }} /></div>}
      <small>PDF · 최대 30MB · 원본은 안전하게 보관됩니다</small>
    </label>
    {notice && <div className="notice warning">{notice}</div>}
    <div className="privacy-note"><FileText /><div><strong>업로드한 자료는 어떻게 사용되나요?</strong><p>내용 분석과 프로필 제작에만 사용되며, 승인한 정보만 최종 결과에 반영됩니다.</p></div></div>
  </section>;
}

function UnsureStep({ value, setValue, onContinue }: { value: string; setValue: (value: string) => void; onContinue: () => void }) {
  const options = ["PDF 프로필", "한글·워드 이력서", "공연 포스터", "사진만 있어요", "SNS·홈페이지 링크", "아무 자료도 없어요"];
  return <section className="stage narrow"><div className="section-heading"><span>자료 확인</span><h1>지금 가지고 있는 자료는 무엇인가요?</h1><p>하나만 골라도 괜찮아요. 가장 쉬운 방법으로 안내해 드릴게요.</p></div><div className="choice-list">{options.map((option) => <button className={value === option ? "selected" : ""} onClick={() => setValue(option)} key={option}><span>{option}</span>{value === option && <CheckCircle2 />}</button>)}</div><button className="button primary wide" disabled={!value} onClick={onContinue}>추천 경로로 계속하기 <ArrowRight size={17} /></button></section>;
}

function NumberedPhotoMenu({ profile, update, uploadImage }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void; uploadImage: (event: ChangeEvent<HTMLInputElement>, representative?: boolean, category?: ProfileImageCategory, targetIndex?: number) => void }) {
  const removePerformanceImage = (targetIndex: number) => {
    const images = [...profile.performanceImages];
    images[targetIndex] = "";
    update("performanceImages", images);
  };

  return <div className="form-card numbered-photo-card"><div className="card-heading"><div><h2>사진 등록</h2><p>처음 등록할 때부터 사진마다 사용할 위치를 지정합니다. 각 메뉴에 한 장씩 선택해 주세요.</p></div><span className="photo-total-count">{(profile.representativeImage ? 1 : 0) + profile.performanceImages.slice(0, 7).filter(Boolean).length} / 8장</span></div><div className="numbered-photo-list">{photoMenuGuides.map((guide) => { const image = guide.number === 1 ? profile.representativeImage : profile.performanceImages[guide.number - 2]; return <article className={image ? "filled" : ""} key={guide.number}><span className="photo-menu-number">사진 {guide.number}</span><div className="photo-menu-copy"><strong>{guide.title}</strong><p>{guide.description}</p>{guide.number === 1 && <small>이 사진은 표지와 웹 이미지 검색의 인물 비교 기준으로 사용됩니다.</small>}</div><label className="photo-menu-upload">{image ? <img src={image} alt={`사진 ${guide.number} ${guide.title}`} /> : <><ImagePlus size={20} /><span>사진 선택</span></>}<input type="file" accept="image/*" onChange={(event) => uploadImage(event, guide.number === 1, guide.category ?? "activity", guide.number === 1 ? undefined : guide.number - 2)} /></label><div className="photo-menu-actions">{image && <><label>교체<input type="file" accept="image/*" onChange={(event) => uploadImage(event, guide.number === 1, guide.category ?? "activity", guide.number === 1 ? undefined : guide.number - 2)} /></label><button aria-label={`${guide.title} 삭제`} onClick={() => guide.number === 1 ? update("representativeImage", undefined) : removePerformanceImage(guide.number - 2)}><X size={14} /> 삭제</button></>}</div></article>; })}</div>{profile.performanceImages.slice(7).filter(Boolean).length > 0 && <div className="legacy-photo-note">기존에 추가한 나머지 사진 {profile.performanceImages.slice(7).filter(Boolean).length}장은 PPT 자산으로 그대로 유지됩니다.</div>}</div>;
}

function ExternalResearchCard({ profile, update }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void }) {
  const [notice, setNotice] = useState("");
  const [sourceKey, setSourceKey] = useState<FreeResearchSource>("namuwiki");
  const [sourceValue, setSourceValue] = useState("");
  const [researchText, setResearchText] = useState("");
  const identitySignals = [profile.primaryField, profile.region, profile.affiliation, profile.activeSince, profile.identityHint, profile.officialUrl].filter(Boolean).length;
  const identityQuery = [profile.artistName, profile.affiliation, profile.primaryField, profile.region, profile.identityHint].filter(Boolean).join(" ");
  const searchLinks = freeResearchSources.map((source) => ({ ...source, href: `https://www.google.com/search?q=${encodeURIComponent(`site:${source.domain} ${identityQuery}`)}` }));

  const addVerifiedResearch = () => {
    const source = freeResearchSources.find((item) => item.key === sourceKey)!;
    if (!profile.artistName.trim() || identitySignals < 2) {
      setNotice("동명이인 방지를 위해 활동명과 분야 외에 지역·소속·대표 경력·공식 링크 중 한 가지 이상을 입력해 주세요.");
      return;
    }
    let sourceUrl: URL;
    try { sourceUrl = new URL(sourceValue.trim()); } catch { setNotice("확인한 원문 주소를 https://로 시작하는 전체 링크로 입력해 주세요."); return; }
    const hostname = sourceUrl.hostname.replace(/^www\./, "");
    if (hostname !== source.domain && !hostname.endsWith(`.${source.domain}`)) { setNotice(`선택한 출처와 주소가 다릅니다. ${source.domain} 원문 주소를 입력해 주세요.`); return; }
    const facts = researchText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
    if (!facts.length) { setNotice("원문에서 본인의 경력·수상·공연 내용을 한 줄에 하나씩 입력해 주세요."); return; }
    const confidence = source.verificationTier === "reference" ? 0.65 : 0.78;
    const newItems: ExtractedItem[] = facts.map((fact) => ({ id: crypto.randomUUID(), type: "career", label: `${source.label} 원문 확인`, value: fact, confidence, status: "approved", sourceName: source.label, sourceUrl: sourceUrl.toString(), verificationTier: source.verificationTier }));
    const existingItemKeys = new Set(profile.extractedItems.map((item) => `${item.sourceUrl}:${item.value}`));
    update("extractedItems", [...profile.extractedItems, ...newItems.filter((item) => !existingItemKeys.has(`${item.sourceUrl}:${item.value}`))]);
    const newCareers = facts.map((fact) => { const year = fact.match(/(?:19|20)\d{2}(?:[.\-/]\d{1,2})?/)?.[0] || ""; const title = fact.replace(year, "").replace(/^[\s·:|,-]+/, "").trim() || fact; return { id: crypto.randomUUID(), year, title, organization: source.label, sourceName: source.label, sourceUrl: sourceUrl.toString(), verificationTier: source.verificationTier }; });
    const careerKeys = new Set(profile.careers.map((career) => `${career.year}:${career.title}:${career.organization}`));
    update("careers", [...profile.careers, ...newCareers.filter((career) => !careerKeys.has(`${career.year}:${career.title}:${career.organization}`))]);
    setResearchText("");
    setNotice(`${source.label}에서 확인한 ${newItems.length}개 항목을 연혁과 PPT 근거에 반영했습니다.`);
  };

  return <div className="form-card research-card"><div className="card-heading"><div><h2>외부 프로필·활동 기록 가져오기</h2><p>나무위키·OTR·쇼글에서 본인 페이지를 찾고, 확인한 경력만 프로필과 PPT에 추가합니다.</p></div><span className="free-mode-badge">무료 검색</span></div><div className="free-search-links">{searchLinks.map((source) => <a href={source.href} target="_blank" rel="noreferrer" key={source.key}><Search size={14} /> {source.label}에서 검색</a>)}</div><div className="manual-research-form"><label><span>확인한 출처</span><select value={sourceKey} onChange={(event) => setSourceKey(event.target.value as FreeResearchSource)}>{freeResearchSources.map((source) => <option value={source.key} key={source.key}>{source.label}</option>)}</select></label><label><span>본인 원문 링크</span><input type="url" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder="https://..." /></label><label className="wide-field"><span>가져올 경력·수상·공연</span><textarea value={researchText} onChange={(event) => setResearchText(event.target.value)} placeholder={"한 줄에 하나씩 입력하세요.\n예: 2024 세종문화회관 단독 공연"} /></label><button onClick={addVerifiedResearch}>확인한 기록 가져오기</button></div>{notice && <div className="notice warning">{notice}</div>}<small>이름만 같다고 자동 반영하지 않습니다. 분야·소속·지역·대표 경력을 대조하고 원문 링크를 PPT 근거로 저장합니다.</small></div>;
}

function InformationStep({ profile, update, setProfile, uploadImage, notice }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void; setProfile: React.Dispatch<React.SetStateAction<ProfileData>>; uploadImage: (event: ChangeEvent<HTMLInputElement>, representative?: boolean, category?: ProfileImageCategory, targetIndex?: number) => void; notice: string }) {
  const extracted = profile.extractedItems;
  const identitySignalCount = [profile.primaryField, profile.region, profile.affiliation, profile.activeSince, profile.identityHint, profile.officialUrl, profile.representativeImage].filter(Boolean).length;
  const identityLevel = identitySignalCount >= 5 ? "높음" : identitySignalCount >= 3 ? "보통" : "준비 필요";
  return <section className="stage form-stage"><div className="section-heading"><span>02 · 프로필 정보</span><h1>{extracted.length ? "추출된 내용을 확인해 주세요" : "예술인에 대해 알려주세요"}</h1><p>{extracted.length ? "PDF에서 찾은 정보입니다. 수정하거나 제외한 뒤 프로필에 반영할 수 있어요." : "긴 글 대신 꼭 필요한 정보만 입력하면 됩니다."}</p></div>
    {notice && <div className={`notice ${notice.includes("부분 분석") ? "warning" : "success"}`}>{notice}</div>}
    {profile.pdfPageAssets.length > 0 && <div className="form-card pdf-assets-card"><div className="card-heading"><div><h2>PDF 이미지 자동 분류</h2><p>AI가 분리한 이미지를 인물·무대·포스터·연혁 자료로 나누고 로고·장식·저화질 이미지는 자동 제외합니다.</p></div><span>{profile.pdfPageAssets.flatMap((asset) => asset.selected ? asset.extractedVisuals?.filter((visual) => visual.selected) ?? [] : []).length}개 이미지 선택</span></div><div className="pdf-page-grid">{profile.pdfPageAssets.map((asset) => <article className={asset.selected ? "selected" : ""} key={asset.pageNumber}><button className="pdf-page-preview" onClick={() => setProfile((current) => ({ ...current, pdfPageAssets: current.pdfPageAssets.map((page) => page.pageNumber === asset.pageNumber ? { ...page, selected: !page.selected } : page) }))}><img src={asset.previewDataUrl} alt={`PDF ${asset.pageNumber}페이지 원문 미리보기`} /><span>{asset.selected ? <Check size={14} /> : <Plus size={14} />}</span></button><div><strong>{asset.pageNumber}페이지 · 분리 이미지 {asset.extractedVisuals?.length ?? 0}개</strong><small className={asset.textSource}>{asset.textSource === "ocr" ? `OCR ${Math.round(asset.confidence * 100)}%` : asset.textSource === "embedded" ? "텍스트 포함" : "원문 근거"}</small></div>{asset.extractedVisuals?.length ? <div className="pdf-extracted-strip">{asset.extractedVisuals.map((visual) => { const label = visual.role ? visualRoleLabels[visual.role] : visual.kind === "photo" ? "사진" : "그래픽"; return <button className={visual.selected ? "selected" : ""} key={visual.id} aria-label={`${asset.pageNumber}페이지 ${label} ${visual.selected ? "제외" : "포함"}`} title={visual.classificationReason} onClick={() => setProfile((current) => ({ ...current, pdfPageAssets: current.pdfPageAssets.map((page) => page.pageNumber !== asset.pageNumber ? page : { ...page, selected: true, extractedVisuals: page.extractedVisuals?.map((item) => item.id === visual.id ? { ...item, selected: !item.selected } : item) }) }))}><img src={visual.dataUrl} alt={`${asset.pageNumber}페이지에서 분리한 ${label}`} /><span>{label}</span></button>; })}</div> : <p className="pdf-no-visual">분리 가능한 큰 이미지가 없습니다. 텍스트·경력 근거로만 사용됩니다.</p>}</article>)}</div></div>}
    {extracted.length > 0 && <div className="review-panel"><div className="review-title"><h2>AI·PDF 분석 결과</h2><span>{extracted.length}개 항목</span></div>{extracted.map((item) => <div className="review-item" key={item.id}><div className={`confidence ${item.confidence < .7 ? "low" : ""}`}>{Math.round(item.confidence * 100)}%</div><label><span>{item.label}{item.pageNumber ? ` · ${item.pageNumber}p` : ""}</span><textarea value={item.value} disabled={item.status === "excluded"} onChange={(event) => setProfile((current) => ({ ...current, extractedItems: current.extractedItems.map((target) => target.id === item.id ? { ...target, value: event.target.value, status: "edited" } : target) }))} /></label><button className={item.status === "excluded" ? "excluded" : ""} onClick={() => setProfile((current) => ({ ...current, extractedItems: current.extractedItems.map((target) => target.id === item.id ? { ...target, status: target.status === "excluded" ? "approved" : "excluded" } : target) }))}>{item.status === "excluded" ? "복원" : "제외"}</button></div>)}</div>}
    <div className="form-card"><h2>기본 정보</h2><div className="form-grid"><label><span>활동명 *</span><input value={profile.artistName} onChange={(event) => update("artistName", event.target.value)} placeholder="예: 김아름 / 아트밴드" /></label><label><span>활동 형태 *</span><div className="segmented"><button className={profile.artistType === "개인" ? "selected" : ""} onClick={() => update("artistType", "개인")}>개인</button><button className={profile.artistType === "단체" ? "selected" : ""} onClick={() => update("artistType", "단체")}>단체</button></div></label><label><span>주 활동 분야 *</span><select value={profile.primaryField} onChange={(event) => update("primaryField", event.target.value)}><option value="">선택해 주세요</option>{fields.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>주요 활동 지역</span><input value={profile.region} onChange={(event) => update("region", event.target.value)} placeholder="예: 서울·경기 / 전국" /></label><label><span>연락 방법</span><input value={profile.contact} onChange={(event) => update("contact", event.target.value)} placeholder="이메일 또는 전화번호" /></label><label className="video-link-field"><span>대표 영상 링크</span><input value={profile.videoUrl} onChange={(event) => update("videoUrl", event.target.value)} placeholder="https://youtu.be/..." /><small>YouTube 주소를 입력하면 PPT에 클릭 가능한 영상 바로가기 버튼이 생성됩니다.</small></label></div></div>
    <ExternalResearchCard profile={profile} update={update} />
    <div className="form-card identity-card"><div className="card-heading"><div><h2>동명이인 방지 정보</h2><p>모두 작성할 필요는 없습니다. 이름 외 식별 단서가 3개 이상이면 검색 정확도가 높아집니다.</p></div><span className={`identity-level level-${identityLevel === "높음" ? "high" : identityLevel === "보통" ? "medium" : "low"}`}>검색 정확도 {identityLevel} · {identitySignalCount}개 단서</span></div><div className="form-grid"><label><span>소속·단체명</span><input value={profile.affiliation} onChange={(event) => update("affiliation", event.target.value)} placeholder="예: ○○예술단 / 소속사" /></label><label><span>활동 시작 연도</span><input value={profile.activeSince} onChange={(event) => update("activeSince", event.target.value)} placeholder="예: 2018" /></label><label className="wide-field"><span>대표 경력 한 줄</span><input value={profile.identityHint} onChange={(event) => update("identityHint", event.target.value)} placeholder="예: 2024 세종문화회관 단독 공연" /></label><label className="wide-field"><span>공식 링크</span><input value={profile.officialUrl} onChange={(event) => update("officialUrl", event.target.value)} placeholder="공식 홈페이지·Instagram·YouTube·쇼글·OTR 주소" /><small>공식 링크는 가장 강한 동일 인물 확인 단서로 사용됩니다.</small></label></div></div>
    <NumberedPhotoMenu profile={profile} update={update} uploadImage={uploadImage} />
    <div className="form-card"><div className="card-heading"><div><h2>연혁·공연·수상</h2><p>PDF에서 찾은 날짜별 활동을 모두 가져왔습니다. 중요한 순서대로 다듬어 주세요.</p></div><button onClick={() => profile.careers.length < 50 && update("careers", [...profile.careers, { id: crypto.randomUUID(), year: "", title: "", organization: "" }])}><Plus size={16} /> 항목 추가</button></div>{profile.careers.map((career) => <div className="career-row" key={career.id}><input value={career.year} onChange={(event) => update("careers", profile.careers.map((item) => item.id === career.id ? { ...item, year: event.target.value } : item))} placeholder="날짜" /><input value={career.title} onChange={(event) => update("careers", profile.careers.map((item) => item.id === career.id ? { ...item, title: event.target.value } : item))} placeholder="공연·활동·수상명" /><input value={career.organization} onChange={(event) => update("careers", profile.careers.map((item) => item.id === career.id ? { ...item, organization: event.target.value } : item))} placeholder="분류·기관·장소" /><button aria-label="경력 삭제" onClick={() => update("careers", profile.careers.filter((item) => item.id !== career.id))}><Trash2 size={16} /></button></div>)}</div>
    <QuestionGroup title="공연에서 가장 자신 있는 특징은 무엇인가요?" hint="최대 3개" options={strengths} selected={profile.strengths} onToggle={(value) => update("strengths", toggleInList(profile.strengths, value, 3))} />
    <QuestionGroup title="어떤 행사 경험이 있나요?" options={experiences} selected={profile.experiences} onToggle={(value) => update("experiences", toggleInList(profile.experiences, value))} />
    <QuestionGroup title="담당자에게 어떤 인상을 주고 싶나요?" hint="최대 3개" options={impressions} selected={profile.impressions} onToggle={(value) => update("impressions", toggleInList(profile.impressions, value, 3))} />
  </section>;
}

function QuestionGroup({ title, hint, options, selected, onToggle }: { title: string; hint?: string; options: string[]; selected: string[]; onToggle: (value: string) => void }) {
  return <div className="form-card"><div className="card-heading"><div><h2>{title}</h2>{hint && <p>{hint}</p>}</div><span>{selected.length}개 선택</span></div><div className="chip-grid">{options.map((option) => <button key={option} className={selected.includes(option) ? "selected" : ""} onClick={() => onToggle(option)}>{selected.includes(option) && <Check size={14} />}{option}</button>)}</div></div>;
}

function ContentStep({ profile, update, busy, generate, notice }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void; busy: boolean; generate: () => void; notice: string }) {
  return <section className="stage form-stage"><div className="section-heading"><span>03 · 콘텐츠</span><h1>예술인의 언어로 다듬어 보세요</h1><p>입력한 사실만 사용해 소개문과 강점을 작성합니다. 결과는 언제든 직접 수정할 수 있어요.</p></div>
    <div className="generator-banner"><div><WandSparkles /><h2>프로필 문구 초안 만들기</h2><p>확인되지 않은 경력과 숫자는 만들지 않습니다.</p></div><button className="button light" disabled={busy} onClick={generate}>{busy ? <Loader2 className="spin" /> : <Sparkles />} {profile.introduction ? "다시 작성" : "문구 생성"}</button></div>
    {notice && <div className="notice success">{notice}</div>}
    <div className="form-card"><label className="full-label"><span>한 줄 소개</span><input value={profile.tagline} onChange={(event) => update("tagline", event.target.value)} placeholder="문구 생성을 누르거나 직접 입력하세요" /></label><label className="full-label"><span>상세 소개문</span><textarea className="large-textarea" value={profile.introduction} onChange={(event) => update("introduction", event.target.value)} placeholder="예술인의 활동과 강점을 소개해 주세요." /><small>{profile.introduction.length}자</small></label></div>
    <div className="form-card"><div className="card-heading"><div><h2>핵심 강점</h2><p>프로필에서 강조할 세 가지 내용입니다.</p></div></div><div className="strength-editor">{(profile.generatedStrengths.length ? profile.generatedStrengths : ["", "", ""]).map((value, index) => <label key={index}><span>0{index + 1}</span><input value={value} placeholder="강점을 입력하세요" onChange={(event) => { const list = profile.generatedStrengths.length ? [...profile.generatedStrengths] : ["", "", ""]; list[index] = event.target.value; update("generatedStrengths", list); }} /></label>)}</div></div>
    <div className="form-card"><h2>문장 설정</h2><div className="form-grid"><label><span>소개문 말투</span><select value={profile.tone} onChange={(event) => update("tone", event.target.value)}><option>전문적이고 명료하게</option><option>지적이고 강렬하게</option><option>따뜻하고 친근하게</option><option>감성적으로</option><option>기업 담당자가 빠르게 이해하도록</option></select></label><label><span>프로필 사용 목적</span><select value={profile.purpose} onChange={(event) => update("purpose", event.target.value)}><option>공공기관 제안</option><option>기업 행사 제안</option><option>축제 섭외</option><option>공연장 제출</option><option>해외 공연 제안</option></select></label></div></div>
  </section>;
}

function DesignStep({ profile, update }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void }) {
  const [searching, setSearching] = useState(false);
  const [searchNotice, setSearchNotice] = useState("");
  const [generatingImages, setGeneratingImages] = useState(false);
  const [generationNotice, setGenerationNotice] = useState("");
  const [candidates, setCandidates] = useState<WebImageCandidate[]>([]);
  const autoSearchKey = useRef("");
  const externalImages = profile.externalImages ?? [];
  const recommendedTemplateKey = recommendTemplateKey(profile);
  const photoAssets = selectPortfolioAssets(collectDeckAssets(profile), 8);
  const visualAssets = photoAssets;
  const availableImageSlots = Math.max(0, FILE_LIMITS.maxPerformanceImages - profile.performanceImages.filter(Boolean).length - externalImages.length);
  const targetVisualCount = Math.min(8, Math.max(5, profile.pageCount));
  const missingImageCount = Math.min(3, availableImageSlots, Math.max(0, targetVisualCount - visualAssets.length));
  const placementCount = Math.min(8, Math.max(5, profile.pageCount));
  const photoPlacements = Array.from({ length: placementCount }, (_, index) => {
    const isLast = index === placementCount - 1;
    const page = index === 0 ? "표지" : index === 1 ? "소개" : index === 2 ? "핵심 강점" : isLast ? "연락·섭외" : `주요 활동·경력 ${index - 2}`;
    const guide = index === 0 ? "얼굴과 분위기가 선명한 대표사진" : isLast ? "아티스트를 기억하게 만드는 마무리 사진" : "페이지의 내용과 직접 연결되는 활동 사진";
    return { page, guide, slots: 1, assets: visualAssets[index] ? [visualAssets[index]] : [] };
  });

  const generateMissingImages = async () => {
    if (!profile.representativeImage) {
      setGenerationNotice("사용자와 닮은 이미지를 만들기 위해 사진 1 대표사진을 먼저 등록해 주세요.");
      return;
    }
    if (!missingImageCount) {
      setGenerationNotice("현재 사진만으로 모든 PPT 페이지의 이미지 구성을 채울 수 있어요.");
      return;
    }
    setGeneratingImages(true);
    setGenerationNotice("Gemini가 대표사진과 실제 경력만 참고해 AI 연출 이미지를 만들고 있어요.");
    try {
      const careerHints = profile.careers
        .filter((career) => career.title.trim() || career.organization.trim())
        .map((career) => [career.year, career.title, career.organization].filter(Boolean).join(" · "));
      const blueprints = [
        { id: "about", purpose: "작업 또는 공연 중인 자연스러운 가로 활동 장면", aspectRatio: "3:2" as const },
        { id: "venue", purpose: "확인된 경력의 공연장과 분야가 자연스럽게 드러나는 넓은 무대 전경", aspectRatio: "16:9" as const },
        { id: "detail", purpose: "연주·작품·의상과 현장 분위기가 보이는 전문적인 디테일 장면", aspectRatio: "3:2" as const },
      ].slice(0, missingImageCount).map((item, index) => ({ ...item, careerHint: careerHints[index % Math.max(1, careerHints.length)] || "" }));
      const referenceImage = await makeImageThumbnail(profile.representativeImage, 768);
      const response = await fetch("/api/ai/generate-profile-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artistName: profile.artistName,
          primaryField: profile.primaryField,
          region: profile.region,
          affiliation: profile.affiliation,
          activeSince: profile.activeSince,
          identityHint: profile.identityHint,
          officialUrl: profile.officialUrl,
          introduction: profile.introduction,
          referenceImage,
          careers: profile.careers,
          requests: blueprints,
        }),
      });
      const result = await response.json() as { images?: GeneratedProfileImage[]; provider?: string; model?: string; error?: string; code?: string };
      if (!response.ok) throw new Error(result.error || "AI 이미지를 생성하지 못했습니다.");
      const additions: ExternalImageAsset[] = (result.images ?? []).map((image) => ({
        id: crypto.randomUUID(),
        dataUrl: image.dataUrl,
        source: "ai",
        title: image.title,
        relevanceScore: 1,
        qualityScore: 0.9,
        disclosure: image.disclosure,
        promptBasis: image.promptBasis,
        usageStatus: "approved",
      }));
      update("externalImages", [...externalImages, ...additions].slice(0, FILE_LIMITS.maxPerformanceImages));
      setGenerationNotice(`${result.provider || "Gemini"}가 ${additions.length}장의 AI 연출 이미지를 만들었어요. 실제 현장 증빙과 구분되도록 PPT 출처 메모와 화면에 표시됩니다.`);
    } catch (error) {
      setGenerationNotice(error instanceof Error ? error.message : "AI 이미지를 생성하지 못했습니다.");
    } finally {
      setGeneratingImages(false);
    }
  };

  const searchArtistImages = async (automatic = false) => {
    if (!profile.artistName.trim() || !profile.representativeImage) {
      setSearchNotice("아티스트명과 대표사진을 먼저 등록해 주세요.");
      return;
    }
    setSearching(true);
    setSearchNotice("무료 Wikimedia와 연결된 네이버·Google·YouTube에서 실제 이미지를 찾고 Gemini가 포트폴리오 적합성을 검수하고 있어요.");
    try {
      const referenceImage = await makeImageThumbnail(profile.representativeImage, 768);
      const response = await fetch("/api/ai/search-artist-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artistName: profile.artistName, primaryField: profile.primaryField, region: profile.region, affiliation: profile.affiliation, activeSince: profile.activeSince, identityHint: profile.identityHint, officialUrl: profile.officialUrl, careers: profile.careers, referenceImage }),
      });
      const result = await response.json() as { candidates?: WebImageCandidate[]; configuredSources?: string[]; error?: string; code?: string };
      if (!response.ok) throw new Error(result.code === "SEARCH_NOT_CONFIGURED" ? "검색 API 키가 아직 설정되지 않았습니다. README의 웹 이미지 검색 설정을 확인해 주세요." : result.error || "이미지 검색에 실패했습니다.");
      const found = result.candidates ?? [];
      setCandidates(found);
      const remaining = Math.max(0, Math.min(4, FILE_LIMITS.maxPerformanceImages - profile.performanceImages.filter(Boolean).length - externalImages.length));
      const safeAdditions: ExternalImageAsset[] = found.filter((candidate) => candidate.recommended && candidate.usageStatus === "approved" && !candidate.watermarkDetected && !externalImages.some((image) => image.sourceUrl === candidate.sourceUrl)).slice(0, remaining).map(approvedWebImage);
      if (safeAdditions.length) update("externalImages", [...externalImages, ...safeAdditions]);
      setSearchNotice(`${(result.configuredSources ?? []).join(" · ")}에서 후보 ${found.length}개를 실제 검색했습니다.${safeAdditions.length ? ` 동일 인물·품질·권리 검수를 통과한 핵심 사진 ${safeAdditions.length}장만 자동 선택했습니다.` : " 자동 사용 가능한 후보가 없어 직접 확인이 필요합니다."}${automatic ? "" : " 후보별 출처도 확인할 수 있습니다."}`);
    } catch (error) {
      setSearchNotice(error instanceof Error ? error.message : "이미지 검색을 완료하지 못했습니다.");
    } finally {
      setSearching(false);
    }
  };

  const addExternalImage = (candidate: WebImageCandidate) => {
    if (candidate.watermarkDetected || candidate.usageStatus === "blocked") {
      setSearchNotice("워터마크 또는 높은 사용 권한 위험이 감지된 이미지는 PPT에 추가할 수 없습니다. 원본 제공자에게 사용 허가를 받거나 다른 후보를 선택해 주세요.");
      return;
    }
    if (externalImages.some((image) => image.sourceUrl === candidate.sourceUrl)) return;
    if (profile.performanceImages.filter(Boolean).length + externalImages.length >= FILE_LIMITS.maxPerformanceImages) {
      setSearchNotice(`공연·웹 사진은 합쳐서 최대 ${FILE_LIMITS.maxPerformanceImages}장까지 추가할 수 있어요.`);
      return;
    }
    update("externalImages", [...externalImages, approvedWebImage(candidate)]);
  };

  const addRecommendedImages = () => {
    const remaining = Math.max(0, FILE_LIMITS.maxPerformanceImages - profile.performanceImages.filter(Boolean).length - externalImages.length);
    const additions: ExternalImageAsset[] = candidates
      .filter((candidate) => candidate.recommended && candidate.usageStatus === "approved" && !candidate.watermarkDetected && !externalImages.some((image) => image.sourceUrl === candidate.sourceUrl))
      .slice(0, Math.min(4, remaining))
      .map(approvedWebImage);
    if (!additions.length) {
      setSearchNotice("자동 추가할 수 있는 워터마크 없는 승인 후보가 없습니다. 출처와 사용 권한을 확인한 뒤 개별 후보를 선택해 주세요.");
      return;
    }
    update("externalImages", [...externalImages, ...additions]);
    setSearchNotice(`워터마크와 권리 위험 검수를 통과한 추천 사진 ${additions.length}장을 추가했어요. 최종 사용 전 출처 페이지의 사용 조건도 확인해 주세요.`);
  };

  useEffect(() => {
    const key = [profile.artistName, profile.primaryField, profile.affiliation, profile.identityHint, profile.representativeImage?.slice(0, 64)].join("|");
    const hasApprovedWebImage = externalImages.some((image) => image.source !== "ai" && image.usageStatus === "approved");
    if (!profile.artistName.trim() || !profile.representativeImage || hasApprovedWebImage || autoSearchKey.current === key) return;
    autoSearchKey.current = key;
    void searchArtistImages(true);
  }, [profile.artistName, profile.primaryField, profile.affiliation, profile.identityHint, profile.representativeImage, externalImages]);

  const selectedPdfVisuals = profile.pdfPageAssets.flatMap((page) => page.selected ? (page.extractedVisuals ?? []).filter((visual) => visual.selected).map((visual) => ({ ...visual, pageNumber: page.pageNumber })) : []);
  return <section className="stage form-stage"><div className="section-heading"><span>04 · 디자인</span><h1>사진과 디자인을 선택해 주세요</h1><p>원문 페이지 전체는 PPT에 넣지 않습니다. 사진은 자연스럽게 크롭하고 포스터·그래픽은 잘리지 않게 독립 프레임으로 배치합니다.</p></div>
    {profile.pdfPageAssets.some((asset) => asset.selected) && <div className="form-card"><div className="card-heading"><div><h2>PDF에서 분류한 디자인 자산</h2><p>인물·무대 사진은 자연스럽게 크롭하고 포스터·연혁 자료는 전체가 보이도록 PPT에 배치합니다.</p></div><span className="photo-total-count">{selectedPdfVisuals.length}개 이미지 포함</span></div>{selectedPdfVisuals.length ? <div className="selected-pdf-assets">{selectedPdfVisuals.map((visual) => { const label = visual.role ? visualRoleLabels[visual.role] : visual.kind === "photo" ? "사진" : "그래픽"; return <article key={`${visual.pageNumber}-${visual.id}`}><img src={visual.dataUrl} alt={`PDF ${visual.pageNumber}페이지에서 분리한 ${label}`} /><strong>{visual.pageNumber}페이지 · {label}</strong><small>{visual.classificationReason}</small><div><button onClick={() => update("representativeImage", visual.dataUrl)}>대표 이미지로 사용</button><span className="pdf-auto-badge">자동 분류 완료</span></div></article>; })}</div> : <div className="empty-media">선택한 원문에서 분리할 수 있는 큰 이미지가 없습니다. 원문은 정보 근거로만 사용되며 PPT 화면에는 들어가지 않습니다.</div>}</div>}
    <div className="form-card ai-image-fill-card"><div className="card-heading"><div><h2>빈 사진 영역 AI로 채우기</h2><p>대표사진과 확인된 경력·장소를 바탕으로 최대 3장의 보조 이미지를 만듭니다. 실제 공연 사진이 아닌 AI 연출 이미지로 명확히 표시됩니다.</p></div><button disabled={generatingImages || !profile.representativeImage || missingImageCount === 0} onClick={() => void generateMissingImages()}>{generatingImages ? <Loader2 className="spin" size={16} /> : <ImagePlus size={16} />} {missingImageCount ? `${missingImageCount}장 생성` : "기본 사진 충족"}</button></div>{generationNotice && <div className="notice warning">{generationNotice}</div>}<small>실제 업로드 사진 → 사용자가 승인한 웹 사진 → AI 연출 이미지 순으로 PPT에 배치됩니다. AI 이미지는 경력의 시각적 이해를 돕는 용도이며 실제 현장 증빙으로 사용하지 않습니다.</small></div>
    <div className="form-card"><div className="card-heading"><div><h2>동일 아티스트 사진 자동 검색</h2><p>기존 대표사진과 웹 후보의 인물·단체 구성, 외형 단서, 공연 맥락을 함께 비교하고 일치 점수 82점 이상만 자동 사용합니다.</p></div><button disabled={searching || !profile.artistName || !profile.representativeImage} onClick={() => void searchArtistImages(false)}>{searching ? <Loader2 className="spin" size={16} /> : <Search size={16} />} 다시 검색</button></div>{!profile.representativeImage && <div className="empty-media">프로필 정보 단계의 사진 1 대표사진을 먼저 등록해 주세요.</div>}</div>
    {(searchNotice || candidates.length > 0) && <div className="form-card web-image-review"><div className="card-heading"><div><h2>웹 이미지 동일 인물 검토</h2><p>{searchNotice}</p></div><div className="web-review-actions"><span>{candidates.filter((candidate) => candidate.recommended).length}개 추천</span>{candidates.some((candidate) => candidate.recommended && !externalImages.some((image) => image.sourceUrl === candidate.sourceUrl)) && <button onClick={addRecommendedImages}>검증 사진 자동 추가</button>}</div></div>{candidates.length > 0 && <div className="web-image-grid">{candidates.map((candidate) => { const added = externalImages.some((image) => image.sourceUrl === candidate.sourceUrl); const blocked = candidate.watermarkDetected || candidate.usageStatus === "blocked"; return <article className={candidate.recommended ? "recommended" : blocked ? "blocked" : ""} key={candidate.id}><div className="web-image-frame"><img src={candidate.dataUrl} alt={candidate.title} />{blocked && <span className="watermark-warning">사용 제외</span>}</div><div className="web-image-meta"><span>{candidate.source.toUpperCase()} · 문맥 {Math.round((candidate.identityScore ?? 0) * 100)} · 시각 일치 {Math.round((candidate.visualMatchScore ?? 0) * 100)} · 품질 {Math.round(candidate.qualityScore * 100)}</span><strong>{candidate.visualRole ? `${visualRoleLabels[candidate.visualRole]} · ` : ""}{candidate.title}</strong>{candidate.referenceSignals?.length ? <small>일치 근거 · {candidate.referenceSignals.join(" · ")}</small> : null}<p>{candidate.reason}</p><div>{candidate.sourceUrl && <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">출처·권한 확인</a>}<button disabled={added || blocked} onClick={() => addExternalImage(candidate)}>{blocked ? "불일치·권한 위험" : added ? "추가됨" : "검토 후 추가"}</button></div></div></article>; })}</div>}</div>}
    {externalImages.length > 0 && <div className="form-card web-photo-section"><div className="card-heading"><div><h2>추가한 보조 사진</h2><p>웹 사진은 출처를, AI 이미지는 생성 사실과 근거 경력을 PPT 메모에 남깁니다.</p></div></div><div className="external-image-list">{externalImages.map((image) => <article className={image.source === "ai" ? "generated" : ""} key={image.id}><img src={image.dataUrl} alt={image.title} /><div><strong>{image.title}</strong>{image.source === "ai" ? <><span className="ai-disclosure">AI 연출 이미지</span><small>{image.promptBasis || image.disclosure}</small></> : image.sourceUrl && <a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.source.toUpperCase()} 출처·권한 확인</a>}</div><button aria-label="보조 이미지 삭제" onClick={() => update("externalImages", externalImages.filter((target) => target.id !== image.id))}><X size={14} /></button></article>)}</div></div>}
    <div className="form-card photo-placement-card"><div className="card-heading"><div><h2>PPT 페이지별 사진 배치</h2><p>기존 자료와 승인된 웹 사진을 우선 사용하며 같은 사진은 두 페이지에 반복하지 않습니다.</p></div></div><div className="photo-placement-grid">{photoPlacements.map((placement) => <article key={placement.page}><div><strong>{placement.page}</strong><p>{placement.guide}</p></div><div className={`photo-placement-slots slots-${placement.slots}`}>{Array.from({ length: placement.slots }, (_, index) => placement.assets[index] ? <img src={placement.assets[index].dataUrl} alt={`${placement.page} 배치 사진 ${index + 1}`} key={`${placement.assets[index].id}-${placement.page}`} /> : <span key={index}>사진 필요</span>)}</div></article>)}</div><small>사진이 부족한 페이지에는 반복 이미지 대신 어떤 사진이 필요한지 구체적인 안내를 표시합니다.</small></div>
    <div className="form-card"><div className="card-heading"><div><h2>장르·제안 목적별 디자인 시스템</h2><p>색상뿐 아니라 타이포그래피, 이미지 방향, 여백과 강조 방식이 다른 6개 시스템입니다.</p></div><button onClick={() => { update("templateMode", "auto"); update("templateKey", recommendedTemplateKey); }}><WandSparkles size={14} /> 자동 추천 적용</button></div><div className="template-grid">{designTemplates.map((item) => { const recommended = item.key === recommendedTemplateKey; return <button key={item.key} className={`template-card ${profile.templateKey === item.key ? "selected" : ""}`} onClick={() => { update("templateMode", "manual"); update("templateKey", item.key); }}><div className={`template-art system-${item.composition}`} style={{ background: item.palette.background, color: item.palette.text, fontFamily: item.typography.heading }}><span style={{ color: item.palette.accent }}>{item.category.toUpperCase()}</span><strong>ARTIST<br />PROPOSAL</strong><i style={{ background: item.palette.accent }} /></div><div><strong>{item.name}{recommended ? " · 추천" : ""}</strong><small>{item.description}</small><em>{item.recommendedFields.join(" · ")} / {item.recommendedPurposes.join(" · ")}</em></div>{profile.templateKey === item.key && <span className="template-check"><Check /></span>}</button>; })}</div><small className="template-auto-note">{profile.templateMode === "manual" ? "직접 선택한 시스템을 유지합니다." : `현재 장르와 목적에 맞춰 ${getTemplate(recommendedTemplateKey).name} 시스템을 자동 적용합니다.`}</small></div>
    <div className="form-card compact"><div className="form-grid"><label><span>페이지 수</span><select value={[5, 6, 8].includes(profile.pageCount) ? profile.pageCount : 6} onChange={(event) => update("pageCount", Number(event.target.value))}><option value={5}>5페이지 · 임팩트형</option><option value={6}>6페이지 · 기본형</option><option value={8}>8페이지 · 상세형</option></select></label><label><span>프로필 목적</span><select value={profile.purpose} onChange={(event) => update("purpose", event.target.value)}><option>공공기관 제안</option><option>기업 행사 제안</option><option>축제 섭외</option><option>공연장 제출</option><option>해외 공연 제안</option></select></label></div></div>
  </section>;
}

function PreviewStep({ profile, template, busy, notice, onEdit, onRetry, onDownload }: { profile: ProfileData; template: ReturnType<typeof getTemplate>; busy: boolean; notice: string; onEdit: () => void; onRetry: () => Promise<void>; onDownload: () => Promise<void> }) {
  const [slide, setSlide] = useState(0);
  const p = template.palette;
  const plans = profile.deckPlan?.slides ?? [];
  const deckFacts = buildDeckFacts(profile);
  const slides = plans.map((plan, planIndex) => {
    const images = plan.imageRefs.map((id) => getDeckAssetData(profile, id)).filter((value): value is string => Boolean(value));
    const careers = plan.careerIndexes.map((index) => deckFacts[index]).filter(Boolean);
    const evidence = careers[0] ? <small className="customer-value-evidence">{formatCustomerValueEvidence(careers[0])}</small> : null;
    if (plan.type === "cover") return <div className={`ai-preview-slide ai-cover has-image ${template.coverImageSide === "left" ? "image-left" : "image-right"}`} key={planIndex}>{images[0] ? <img src={images[0]} alt="표지" /> : <div className="ai-photo-placeholder cover"><strong>이미지 준비 안내</strong><span>{plan.imagePurpose || "얼굴이 선명한 세로 대표사진 · 반신 또는 전신"}</span></div>}<div className="ai-image-shade" /><div className="ai-slide-copy"><span>{plan.eyebrow}</span><h1>{plan.title}</h1><p>{plan.body}</p><small>{profile.primaryField} · {profile.region}</small>{evidence}</div></div>;
    if (plan.type === "gallery") {
      return <div className="ai-preview-slide ai-gallery single" key={planIndex}><div className="ai-gallery-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2>{plan.body && <p>{plan.body}</p>}</div>{images[0] ? <img src={images[0]} alt="대표 활동 장면" /> : <div className="ai-photo-placeholder"><strong>이미지 준비 안내</strong><span>{plan.imagePurpose || "대표 활동을 한눈에 보여주는 사진 한 장"}</span></div>}{evidence}</div>;
    }
    if (plan.type === "strengths") return <div className="ai-preview-slide ai-strengths ai-visual-split" key={planIndex}><div className="ai-visual-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2><div>{plan.bullets.slice(0, 3).map((item, index) => <article key={index}><small>0{index + 1}</small><strong>{item}</strong></article>)}</div></div>{images[0] ? <img src={images[0]} alt="핵심 강점 활동 이미지" /> : <div className="ai-photo-placeholder"><strong>이미지 준비 안내</strong><span>{plan.imagePurpose}</span></div>}{evidence}</div>;
    if (plan.type === "career") {
      const visibleCareers = careers.slice(0, 10);
      const twoColumns = visibleCareers.length > 5;
      return <div className={`ai-preview-slide ai-career ai-visual-split ${twoColumns ? "two-column" : ""}`} key={planIndex}><div className="ai-visual-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2><div className="career-list">{visibleCareers.map((item) => { const display = formatCareerFact(item, false); return <div className="preview-career" key={item.id}><b>{display.date}</b><strong>{display.title}</strong>{display.meta && <small>{display.meta}</small>}</div>; })}</div></div>{images[0] ? <img src={images[0]} alt="주요 경력 활동 이미지" /> : <div className="ai-photo-placeholder"><strong>이미지 준비 안내</strong><span>{plan.imagePurpose}</span></div>}</div>;
    }
    if (plan.type === "contact") {
      const contactText = profile.contact || plan.bullets.find((item) => !/^https?:\/\//i.test(item)) || "연락 가능한 전화번호 또는 이메일을 입력해 주세요";
      const videoUrl = normalizeVideoUrl(profile.videoUrl || profile.officialUrl || plan.bullets.find((item) => /^https?:\/\//i.test(item)) || "");
      return <div className="ai-preview-slide ai-contact ai-visual-split" key={planIndex}><div className="ai-visual-copy"><span>BOOKING & CONTACT</span><h2>{plan.title || "행사 목적에 맞는 무대를 제안드립니다"}</h2><p>{plan.body || [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · ")}</p><div><article><small>CONTACT</small><strong>{contactText}</strong></article>{videoUrl && <article className="preview-video-row"><small>VIDEO</small><a href={videoUrl} target="_blank" rel="noreferrer"><b>▶</b>{isYouTubeVideoUrl(videoUrl) ? "YouTube 대표 영상 바로 보기" : "대표 영상 바로 보기"}</a></article>}</div><em>일정과 행사 정보를 보내주시면 목적에 맞는 구성으로 답변드리겠습니다.</em></div>{images[0] ? <img src={images[0]} alt="섭외 문의 마무리 이미지" /> : <div className="ai-photo-placeholder"><strong>이미지 준비 안내</strong><span>{plan.imagePurpose}</span></div>}{evidence}</div>;
    }
    const imageOnLeft = plan.layout === "split_left";
    return <div className={`ai-preview-slide ai-split has-image ${imageOnLeft ? "image-left" : "image-right"}`} key={planIndex}>{images[0] ? <img src={images[0]} alt="소개 이미지" /> : <div className="ai-photo-placeholder split"><strong>이미지 준비 안내</strong><span>{plan.imagePurpose || "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장"}</span></div>}<div className="ai-slide-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2><p>{plan.body}</p>{plan.bullets.length > 0 && <ul>{plan.bullets.map((item, index) => <li key={index}>{item}</li>)}</ul>}{evidence}</div></div>;
  });
  const visibleSlides = slides.length ? slides : [<div className="ai-preview-slide ai-cover" key="empty"><div className="ai-slide-copy"><span>ARTIST PROFILE</span><h1>{profile.artistName}</h1><p>{profile.tagline}</p></div></div>];
  const activePlan = plans[slide];
  const isAiPlan = profile.deckPlanMeta?.mode === "ai";
  return <section className="preview-page"><div className="preview-top"><div><span>05 · 완성</span><h1>{isAiPlan ? "Gemini가 구성한 프로필입니다" : "기본 구성으로 만든 프로필입니다"}</h1><p>현재 미리보기와 다운로드되는 PPTX는 같은 페이지 기획·문구·사진 배치를 사용합니다.</p></div><div className="preview-actions"><button className="button ghost" onClick={onEdit}><PenLine size={16} /> 내용 수정</button>{!isAiPlan && <button className="button ghost" disabled={busy} onClick={() => void onRetry()}><RotateCcw size={16} /> Gemini 다시 시도</button>}<button className="button primary" disabled={busy} onClick={() => void onDownload()}>{busy ? <Loader2 className="spin" size={17} /> : <Download size={17} />} {busy ? "PPTX 제작 중" : "이 구성으로 PPTX 다운로드"}</button></div></div>
    {notice && <div className={`notice ${notice.includes("문제가") || notice.includes("기본 구성") ? "warning" : "success"}`}>{notice}</div>}
    <div className="preview-workspace"><div className="slide-rail">{visibleSlides.map((item, index) => { const plan = plans[index]; const image = plan?.imageRefs[0] ? getDeckAssetData(profile, plan.imageRefs[0]) : ""; return <button className={slide === index ? "selected" : ""} onClick={() => setSlide(index)} key={index}><span>{index + 1}</span><div style={{ background: image ? `linear-gradient(#0007,#0007),url(${image}) center/cover` : p.background, color: p.text }}>{plan?.title || profile.artistName || "ARTIST"}</div></button>; })}</div><div className="canvas-wrap"><div className={`slide-canvas ai-plan-canvas preview-system-${template.composition}`} style={{ background: slide % 2 ? p.surface : p.background, color: p.text, "--accent": p.accent, "--muted": p.muted, "--heading-font": template.typography.heading, "--body-font": template.typography.body } as React.CSSProperties}>{visibleSlides[slide]}</div>{activePlan?.imagePurpose && <small className="image-purpose">사진 역할 · {activePlan.imagePurpose}</small>}<div className="canvas-controls"><button onClick={() => setSlide(Math.max(0, slide - 1))}><ArrowLeft /></button><span>{slide + 1} / {visibleSlides.length}</span><button onClick={() => setSlide(Math.min(visibleSlides.length - 1, slide + 1))}><ArrowRight /></button></div></div></div>
    <div className="completion-grid"><article><CheckCircle2 /><div><strong>수정 가능한 PPTX</strong><p>텍스트와 도형을 파워포인트에서 직접 편집할 수 있어요.</p></div></article><article><LayoutTemplate /><div><strong>{template.name}</strong><p>{profile.pageCount}페이지 구성에 맞춰 자동 배치됩니다.</p></div></article><article><RotateCcw /><div><strong>초안 자동 저장</strong><p>브라우저에서 언제든 이어서 수정할 수 있어요.</p></div></article></div></section>;
}
