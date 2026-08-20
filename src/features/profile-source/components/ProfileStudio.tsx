"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, CircleHelp, Download, FileText,
  ImagePlus, LayoutTemplate, Loader2, Menu, PenLine, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, WandSparkles, X,
} from "lucide-react";
import { ExternalImageAsset, ExtractedItem, initialProfile, PdfExtractedVisual, PdfPageAsset, ProfileData, ProfileImageCategory, SourceType } from "@/types/profile";
import { designTemplates, getTemplate } from "@/features/design-templates/registry/templates";
import { FILE_LIMITS } from "@/config/file-limits";
import { collectDeckAssets, downloadPptx, getDeckAssetData, isYouTubeVideoUrl, makeImageThumbnail, normalizeVideoUrl, prepareDeckPlan, selectPortfolioAssets } from "@/features/profile-export/pptx/generate-pptx";
import { buildDeckFacts, formatCareerFact } from "@/features/profile-export/pptx/deck-facts";
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
      return { id: crypto.randomUUID(), year, title: item.value.replace(year, "").replace(/^\s*[·.\-/]\s*/, "").trim(), organization: item.pageNumber ? `${item.label} · ${item.pageNumber}p` : item.label };
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
      if (aiProfile?.visualRegions?.length) data.pages = await cropAiVisualRegions(data.pages, aiProfile.visualRegions);
      const name = aiProfile?.artistName || finalItems.find((item) => item.type === "artist_name")?.value;
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
    update("source", files.some((file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) ? "pdf" : "questionnaire");
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
    if (pdf) void uploadPdf(pdf);
    else {
      setNotice(`${images.length}장의 사진을 등록했어요. 대표사진과 활동사진을 자동으로 나눴습니다.`);
      setStep(1);
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
    setNotice("입력한 자료로 소개문을 보완하고 PPT 초안을 만들고 있어요.");
    try {
      let workingProfile = profile;
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
        ? `${prepared.meta.provider} · ${prepared.meta.model}이 ${prepared.plan.slides.length}페이지를 구성했어요. 품질 검사 ${prepared.meta.qualityScore ?? 90}점 · 근거 ${prepared.meta.coveredFactCount ?? 0}/${prepared.meta.totalFactCount ?? 0}개 반영.`
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

      {step === 0 && <QuickStartStep profile={profile} update={update} progress={pdfProgress} fileName={pdfName} busy={busy} notice={notice} aiStatus={aiStatus} onUpload={uploadQuickMaterials} onSkip={() => { update("source", "questionnaire"); setStep(1); }} />}
      {step === 1 && <QuickReviewStep profile={profile} update={update} setProfile={setProfile} uploadImage={uploadImage} busy={busy} notice={notice} generate={generateCopy} onBuild={prepareDeck} />}
      {step === 2 && <PreviewStep profile={profile} template={template} busy={busy} notice={notice} onEdit={() => setStep(1)} onRetry={prepareDeck} onDownload={exportDeck} />}
    </main>
  );
}

function QuickStartStep({ profile, update, progress, fileName, busy, notice, aiStatus, onUpload, onSkip }: {
  profile: ProfileData;
  update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void;
  progress: number;
  fileName: string;
  busy: boolean;
  notice: string;
  aiStatus: AiStatus;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSkip: () => void;
}) {
  const { config } = useSiteSettings();
  const [linkValue, setLinkValue] = useState(profile.videoUrl || profile.officialUrl);
  const saveLink = () => {
    const link = linkValue.trim();
    if (!link) return;
    if (isYouTubeVideoUrl(link)) update("videoUrl", normalizeVideoUrl(link));
    else update("officialUrl", link);
  };
  const sectionContent: Record<string, React.ReactNode> = {
    identity: <div className="quick-identity-row" key="identity"><label><span>활동명 또는 팀명</span><input value={profile.artistName} onChange={(event) => update("artistName", event.target.value)} placeholder="예: 김아트 / 아트앙상블" /></label><label><span>분야</span><select value={profile.primaryField} onChange={(event) => update("primaryField", event.target.value)}><option value="">자료에서 자동 찾기</option>{fields.map((field) => <option key={field}>{field}</option>)}</select></label></div>,
    upload: <label className={`unified-dropzone ${busy ? "busy" : ""}`} key="upload"><input type="file" accept="application/pdf,image/*" multiple disabled={busy} onChange={onUpload} /><span className="dropzone-icon">{busy ? <Loader2 className="spin" /> : <Upload />}</span><strong>{busy ? "자료를 읽고 있어요" : config.home.uploadTitle}</strong><small>{config.home.uploadDescription}</small></label>,
    link: <div className="quick-link-row" key="link"><label><span>링크가 있다면 붙여넣기 <small>선택</small></span><input value={linkValue} onChange={(event) => setLinkValue(event.target.value)} onBlur={saveLink} placeholder="홈페이지·Instagram·YouTube 링크" /></label><button onClick={saveLink}>링크 저장</button></div>,
    aiStatus: <div className="quick-ai-state" key="aiStatus"><CheckCircle2 size={15} /><span>{aiStatus.configured ? `${aiStatus.provider}가 이미지형 PDF와 사진 속 글자까지 분석합니다.` : "AI 한도가 없어도 기본 OCR로 자료를 정리합니다."}</span></div>,
  };
  return <section className="hero quick-start-page">
    <div className="eyebrow"><Sparkles size={14} /> {config.home.eyebrow}</div>
    <h1>{config.home.title}<br /><em>{config.home.accentTitle}</em></h1>
    <p>{config.home.description}</p>
    <div className="quick-start-card">
      {config.home.sections.filter((section) => section.enabled && section.key !== "trust").map((section) => sectionContent[section.key])}
      {(busy || progress > 0) && <div className="quick-analysis-progress"><div><span style={{ width: `${progress}%` }} /></div><strong>{fileName || "업로드한 자료"} · {progress}%</strong></div>}
      {notice && <div className="notice warning">{notice}</div>}
    </div>
    <button className="text-start-button" onClick={onSkip}>{config.home.noMaterialLabel} <ArrowRight size={15} /></button>
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
    <div className="quick-media-card"><div><div className="quick-cover-photo">{profile.representativeImage ? <img src={profile.representativeImage} alt="대표사진" /> : <ImagePlus />}<label><input type="file" accept="image/*" onChange={(event) => uploadImage(event, true)} />{profile.representativeImage ? "대표사진 바꾸기" : "대표사진 추가"}</label></div><div><h2>사진은 위치를 자동으로 정합니다</h2><p>첫 사진은 표지, 나머지는 활동 갤러리에 원본 비율로 배치합니다.</p><label className="quick-add-photos"><input type="file" accept="image/*" multiple onChange={(event) => uploadImage(event, false, "activity")} /><Plus size={14} /> 활동사진 더 추가</label><small>현재 대표사진 {profile.representativeImage ? 1 : 0}장 · 활동사진 {profile.performanceImages.filter(Boolean).length}장</small></div></div></div>
    <div className="quick-review-card"><div className="card-heading"><div><h2>찾아낸 경력·수상·공연</h2><p>초록색은 반영, 회색은 제외됩니다.</p></div><span>{reviewItems.length || realCareers.length}개 발견</span></div>{reviewItems.length ? <div className="fact-confirm-list">{reviewItems.map((item) => <article className={item.status === "excluded" ? "excluded" : "approved"} key={item.id}><div><span>{item.type === "award" ? "수상" : item.type === "performance" ? "공연" : item.type === "media" ? "보도" : "경력"}{item.pageNumber ? ` · ${item.pageNumber}p` : ""}</span><strong>{item.value}</strong></div><div><button className={item.status !== "excluded" ? "selected" : ""} onClick={() => setItemStatus(item.id, "approved")}><Check size={13} /> 맞아요</button><button className={item.status === "excluded" ? "selected exclude" : ""} onClick={() => setItemStatus(item.id, "excluded")}><X size={13} /> 제외</button></div></article>)}</div> : <div className="empty-facts"><FileText /><strong>아직 추출된 경력이 없습니다</strong><p>세부 설정에서 경력 한 줄만 추가해도 PPT를 만들 수 있어요.</p></div>}</div>
    {!profile.introduction.trim() && <button className="quick-copy-button" disabled={busy || !profile.artistName.trim()} onClick={generate}>{busy ? <Loader2 className="spin" /> : <WandSparkles />} 자료로 소개문 자동 작성</button>}
    {notice && <div className="notice warning quick-notice">{notice}</div>}
    <details className="advanced-settings"><summary><PenLine size={15} /> 세부 정보·사진·디자인 직접 수정 <ChevronRight size={15} /></summary><div><InformationStep profile={profile} update={update} setProfile={setProfile} uploadImage={uploadImage} notice={notice} /><ContentStep profile={profile} update={update} busy={busy} generate={generate} notice={notice} /><DesignStep profile={profile} update={update} /></div></details>
    <div className="quick-build-bar"><div><strong>{profile.artistName || "아티스트"} 프로필 초안</strong><span>부족한 문구는 자동으로 보완한 뒤 미리보기를 만듭니다.</span></div><button disabled={busy || !profile.artistName.trim() || !profile.primaryField.trim()} onClick={() => void onBuild()}>{busy ? <><Loader2 className="spin" /> PPT 구성 중</> : <>PPT 미리보기 만들기 <ArrowRight size={16} /></>}</button></div>
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

function InformationStep({ profile, update, setProfile, uploadImage, notice }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void; setProfile: React.Dispatch<React.SetStateAction<ProfileData>>; uploadImage: (event: ChangeEvent<HTMLInputElement>, representative?: boolean, category?: ProfileImageCategory, targetIndex?: number) => void; notice: string }) {
  const extracted = profile.extractedItems;
  const identitySignalCount = [profile.primaryField, profile.region, profile.affiliation, profile.activeSince, profile.identityHint, profile.officialUrl, profile.representativeImage].filter(Boolean).length;
  const identityLevel = identitySignalCount >= 5 ? "높음" : identitySignalCount >= 3 ? "보통" : "준비 필요";
  return <section className="stage form-stage"><div className="section-heading"><span>02 · 프로필 정보</span><h1>{extracted.length ? "추출된 내용을 확인해 주세요" : "예술인에 대해 알려주세요"}</h1><p>{extracted.length ? "PDF에서 찾은 정보입니다. 수정하거나 제외한 뒤 프로필에 반영할 수 있어요." : "긴 글 대신 꼭 필요한 정보만 입력하면 됩니다."}</p></div>
    {notice && <div className={`notice ${notice.includes("부분 분석") ? "warning" : "success"}`}>{notice}</div>}
    {profile.pdfPageAssets.length > 0 && <div className="form-card pdf-assets-card"><div className="card-heading"><div><h2>PDF 사진·그림 분리</h2><p>원문 페이지는 근거 확인용으로만 보관하고, 안에 포함된 큰 사진·포스터·그래픽을 별도 자산으로 분리합니다.</p></div><span>{profile.pdfPageAssets.flatMap((asset) => asset.selected ? asset.extractedVisuals?.filter((visual) => visual.selected) ?? [] : []).length}개 이미지 선택</span></div><div className="pdf-page-grid">{profile.pdfPageAssets.map((asset) => <article className={asset.selected ? "selected" : ""} key={asset.pageNumber}><button className="pdf-page-preview" onClick={() => setProfile((current) => ({ ...current, pdfPageAssets: current.pdfPageAssets.map((page) => page.pageNumber === asset.pageNumber ? { ...page, selected: !page.selected } : page) }))}><img src={asset.previewDataUrl} alt={`PDF ${asset.pageNumber}페이지 원문 미리보기`} /><span>{asset.selected ? <Check size={14} /> : <Plus size={14} />}</span></button><div><strong>{asset.pageNumber}페이지 · 분리 이미지 {asset.extractedVisuals?.length ?? 0}개</strong><small className={asset.textSource}>{asset.textSource === "ocr" ? `OCR ${Math.round(asset.confidence * 100)}%` : asset.textSource === "embedded" ? "텍스트 포함" : "원문 근거"}</small></div>{asset.extractedVisuals?.length ? <div className="pdf-extracted-strip">{asset.extractedVisuals.map((visual) => <button className={visual.selected ? "selected" : ""} key={visual.id} aria-label={`${asset.pageNumber}페이지 ${visual.kind === "photo" ? "사진" : "그래픽"} ${visual.selected ? "제외" : "포함"}`} onClick={() => setProfile((current) => ({ ...current, pdfPageAssets: current.pdfPageAssets.map((page) => page.pageNumber !== asset.pageNumber ? page : { ...page, selected: true, extractedVisuals: page.extractedVisuals?.map((item) => item.id === visual.id ? { ...item, selected: !item.selected } : item) }) }))}><img src={visual.dataUrl} alt={`${asset.pageNumber}페이지에서 분리한 ${visual.kind === "photo" ? "사진" : "그래픽"}`} /><span>{visual.kind === "photo" ? "사진" : "그래픽"}</span></button>)}</div> : <p className="pdf-no-visual">분리 가능한 큰 이미지가 없습니다. 텍스트·경력 근거로만 사용됩니다.</p>}</article>)}</div></div>}
    {extracted.length > 0 && <div className="review-panel"><div className="review-title"><h2>AI·PDF 분석 결과</h2><span>{extracted.length}개 항목</span></div>{extracted.map((item) => <div className="review-item" key={item.id}><div className={`confidence ${item.confidence < .7 ? "low" : ""}`}>{Math.round(item.confidence * 100)}%</div><label><span>{item.label}{item.pageNumber ? ` · ${item.pageNumber}p` : ""}</span><textarea value={item.value} disabled={item.status === "excluded"} onChange={(event) => setProfile((current) => ({ ...current, extractedItems: current.extractedItems.map((target) => target.id === item.id ? { ...target, value: event.target.value, status: "edited" } : target) }))} /></label><button className={item.status === "excluded" ? "excluded" : ""} onClick={() => setProfile((current) => ({ ...current, extractedItems: current.extractedItems.map((target) => target.id === item.id ? { ...target, status: target.status === "excluded" ? "approved" : "excluded" } : target) }))}>{item.status === "excluded" ? "복원" : "제외"}</button></div>)}</div>}
    <div className="form-card"><h2>기본 정보</h2><div className="form-grid"><label><span>활동명 *</span><input value={profile.artistName} onChange={(event) => update("artistName", event.target.value)} placeholder="예: 김아름 / 아트밴드" /></label><label><span>활동 형태 *</span><div className="segmented"><button className={profile.artistType === "개인" ? "selected" : ""} onClick={() => update("artistType", "개인")}>개인</button><button className={profile.artistType === "단체" ? "selected" : ""} onClick={() => update("artistType", "단체")}>단체</button></div></label><label><span>주 활동 분야 *</span><select value={profile.primaryField} onChange={(event) => update("primaryField", event.target.value)}><option value="">선택해 주세요</option>{fields.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>주요 활동 지역</span><input value={profile.region} onChange={(event) => update("region", event.target.value)} placeholder="예: 서울·경기 / 전국" /></label><label><span>연락 방법</span><input value={profile.contact} onChange={(event) => update("contact", event.target.value)} placeholder="이메일 또는 전화번호" /></label><label className="video-link-field"><span>대표 영상 링크</span><input value={profile.videoUrl} onChange={(event) => update("videoUrl", event.target.value)} placeholder="https://youtu.be/..." /><small>YouTube 주소를 입력하면 PPT에 클릭 가능한 영상 바로가기 버튼이 생성됩니다.</small></label></div></div>
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
  const [researchNotice, setResearchNotice] = useState("");
  const [researchSource, setResearchSource] = useState<FreeResearchSource>("namuwiki");
  const [researchSourceUrl, setResearchSourceUrl] = useState("");
  const [researchText, setResearchText] = useState("");
  const [candidates, setCandidates] = useState<WebImageCandidate[]>([]);
  const autoSearchKey = useRef("");
  const externalImages = profile.externalImages ?? [];
  const photoAssets = selectPortfolioAssets(collectDeckAssets(profile), 4);
  const visualAssets = photoAssets;
  const galleryVisualAssets = visualAssets.slice(2);
  const availableImageSlots = Math.max(0, FILE_LIMITS.maxPerformanceImages - profile.performanceImages.filter(Boolean).length - externalImages.length);
  const missingImageCount = Math.min(2, availableImageSlots, Math.max(0, 4 - visualAssets.length));
  const searchIdentitySignalCount = [profile.primaryField, profile.region, profile.affiliation, profile.activeSince, profile.identityHint, profile.officialUrl, profile.representativeImage].filter(Boolean).length;
  const galleryPageCount = galleryVisualAssets.length;
  const photoPlacements = [
    { page: "표지", guide: "얼굴과 분위기가 선명한 세로 대표사진", slots: 1, assets: visualAssets.slice(0, 1) },
    { page: "소개", guide: "작업 또는 연주 중인 자연스러운 가로 사진", slots: 1, assets: visualAssets.slice(1, 2) },
    ...Array.from({ length: galleryPageCount }, (_, index) => ({ page: `대표 장면 ${index + 1}`, guide: "한 페이지에 메시지 하나와 가장 강한 활동 사진 한 장", slots: 1, assets: galleryVisualAssets.slice(index, index + 1) })),
  ];

  const researchIdentityQuery = [profile.artistName, profile.affiliation, profile.primaryField, profile.region, profile.identityHint].filter(Boolean).join(" ");
  const researchSearchLinks = freeResearchSources.map((source) => ({
    ...source,
    href: `https://www.google.com/search?q=${encodeURIComponent(`site:${source.domain} ${researchIdentityQuery}`)}`,
  }));

  const addVerifiedResearch = () => {
    const source = freeResearchSources.find((item) => item.key === researchSource)!;
    if (searchIdentitySignalCount < 2) {
      setResearchNotice("동명이인 방지를 위해 활동 분야 외에 지역·소속·대표 경력·공식 링크 중 한 가지 이상을 입력해 주세요.");
      return;
    }
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(researchSourceUrl.trim());
    } catch {
      setResearchNotice("확인한 원문 주소를 https://로 시작하는 전체 링크로 입력해 주세요.");
      return;
    }
    const hostname = sourceUrl.hostname.replace(/^www\./, "");
    if (hostname !== source.domain && !hostname.endsWith(`.${source.domain}`)) {
      setResearchNotice(`선택한 출처와 주소가 다릅니다. ${source.domain} 원문 주소를 입력해 주세요.`);
      return;
    }
    const facts = researchText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
    if (!facts.length) {
      setResearchNotice("원문에서 본인의 경력·수상·공연 내용을 한 줄에 하나씩 입력해 주세요.");
      return;
    }
    const confidence = source.verificationTier === "reference" ? 0.65 : 0.78;
    const newItems: ExtractedItem[] = facts.map((fact) => ({
      id: crypto.randomUUID(),
      type: "career",
      label: `${source.label} 원문 확인`,
      value: fact,
      confidence,
      status: "approved",
      sourceName: source.label,
      sourceUrl: sourceUrl.toString(),
      verificationTier: source.verificationTier,
    }));
    const existingItemKeys = new Set(profile.extractedItems.map((item) => `${item.sourceUrl}:${item.value}`));
    update("extractedItems", [...profile.extractedItems, ...newItems.filter((item) => !existingItemKeys.has(`${item.sourceUrl}:${item.value}`))]);
    const newCareers = facts.map((fact) => {
      const year = fact.match(/(?:19|20)\d{2}(?:[.\-/]\d{1,2})?/)?.[0] || "";
      const title = fact.replace(year, "").replace(/^[\s·:|,-]+/, "").trim() || fact;
      return { id: crypto.randomUUID(), year, title, organization: source.label, sourceName: source.label, sourceUrl: sourceUrl.toString(), verificationTier: source.verificationTier };
    });
    const careerKeys = new Set(profile.careers.map((career) => `${career.year}:${career.title}:${career.organization}`));
    update("careers", [...profile.careers, ...newCareers.filter((career) => !careerKeys.has(`${career.year}:${career.title}:${career.organization}`))]);
    setResearchText("");
    setResearchNotice(`${source.label}에서 직접 확인한 ${newItems.length}개 항목을 연혁과 PPT 출처에 반영했습니다.`);
  };

  const generateMissingImages = async () => {
    if (!profile.representativeImage) {
      setGenerationNotice("사용자와 닮은 이미지를 만들기 위해 사진 1 대표사진을 먼저 등록해 주세요.");
      return;
    }
    if (!missingImageCount) {
      setGenerationNotice("현재 사진만으로 표지·소개·갤러리의 기본 구성을 채울 수 있어요.");
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
      const remaining = Math.max(0, Math.min(2, FILE_LIMITS.maxPerformanceImages - profile.performanceImages.filter(Boolean).length - externalImages.length));
      const safeAdditions: ExternalImageAsset[] = found.filter((candidate) => candidate.recommended && candidate.usageStatus === "approved" && !candidate.watermarkDetected && !externalImages.some((image) => image.sourceUrl === candidate.sourceUrl)).slice(0, remaining).map((candidate) => ({ id: crypto.randomUUID(), dataUrl: candidate.dataUrl, source: candidate.source, sourceUrl: candidate.sourceUrl, title: candidate.title, relevanceScore: candidate.relevanceScore, qualityScore: candidate.qualityScore, usageStatus: "approved" }));
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
    update("externalImages", [...externalImages, { id: crypto.randomUUID(), dataUrl: candidate.dataUrl, source: candidate.source, sourceUrl: candidate.sourceUrl, title: candidate.title, relevanceScore: candidate.relevanceScore, qualityScore: candidate.qualityScore, watermarkDetected: candidate.watermarkDetected, usageStatus: "approved" }]);
  };

  const addRecommendedImages = () => {
    const remaining = Math.max(0, FILE_LIMITS.maxPerformanceImages - profile.performanceImages.filter(Boolean).length - externalImages.length);
    const additions: ExternalImageAsset[] = candidates
      .filter((candidate) => candidate.recommended && candidate.usageStatus === "approved" && !candidate.watermarkDetected && !externalImages.some((image) => image.sourceUrl === candidate.sourceUrl))
      .slice(0, Math.min(2, remaining))
      .map((candidate) => ({ id: crypto.randomUUID(), dataUrl: candidate.dataUrl, source: candidate.source, sourceUrl: candidate.sourceUrl, title: candidate.title, relevanceScore: candidate.relevanceScore, qualityScore: candidate.qualityScore, usageStatus: "approved" }));
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
    {profile.pdfPageAssets.some((asset) => asset.selected) && <div className="form-card"><div className="card-heading"><div><h2>PDF에서 분리한 디자인 자산</h2><p>원문의 텍스트는 경력·수상 근거로 사용하고, 아래 사진·그림만 실제 PPT 디자인에 배치합니다.</p></div><span className="photo-total-count">{selectedPdfVisuals.length}개 이미지 포함</span></div>{selectedPdfVisuals.length ? <div className="selected-pdf-assets">{selectedPdfVisuals.map((visual) => <article key={`${visual.pageNumber}-${visual.id}`}><img src={visual.dataUrl} alt={`PDF ${visual.pageNumber}페이지에서 분리한 ${visual.kind === "photo" ? "사진" : "그래픽"}`} /><strong>{visual.pageNumber}페이지 · {visual.kind === "photo" ? "사진" : "그래픽"}</strong><div><button onClick={() => update("representativeImage", visual.dataUrl)}>대표 이미지로 사용</button><span className="pdf-auto-badge">개별 자산 배치</span></div></article>)}</div> : <div className="empty-media">선택한 원문에서 분리할 수 있는 큰 이미지가 없습니다. 원문은 정보 근거로만 사용되며 PPT 화면에는 들어가지 않습니다.</div>}</div>}
    <div className="form-card research-card"><div className="card-heading"><div><h2>무료 외부 기록 검색</h2><p>유료 검색 API 없이 나무위키·OTR·쇼글 검색을 열고, 본인 자료로 확인한 내용만 PPT에 반영합니다.</p></div><span className="free-mode-badge">API 비용 0원</span></div><div className="free-search-links">{researchSearchLinks.map((source) => <a href={source.href} target="_blank" rel="noreferrer" key={source.key}><Search size={14} /> {source.label}에서 검색</a>)}</div><div className="manual-research-form"><label><span>확인한 출처</span><select value={researchSource} onChange={(event) => setResearchSource(event.target.value as FreeResearchSource)}>{freeResearchSources.map((source) => <option value={source.key} key={source.key}>{source.label}</option>)}</select></label><label><span>확인한 원문 링크</span><input type="url" value={researchSourceUrl} onChange={(event) => setResearchSourceUrl(event.target.value)} placeholder="https://..." /></label><label className="wide-field"><span>본인과 일치하는 내용</span><textarea value={researchText} onChange={(event) => setResearchText(event.target.value)} placeholder={"한 줄에 하나씩 입력하세요.\n예: 2024 세종문화회관 단독 공연\n예: 2023 ○○예술대상 수상"} /></label><button onClick={addVerifiedResearch}>확인한 기록을 연혁·PPT에 반영</button></div>{researchNotice && <div className="notice warning">{researchNotice}</div>}<small>검색 결과는 자동으로 가져오지 않으므로 검색 비용이 발생하지 않습니다. 이름·분야·지역·소속·대표사진을 대조한 뒤 본인 원문만 입력해 주세요. 출처 링크는 PPT 근거에 함께 저장됩니다.</small></div>
    <div className="form-card ai-image-fill-card"><div className="card-heading"><div><h2>빈 사진 영역 AI로 채우기</h2><p>대표사진과 확인된 경력·장소를 바탕으로 최대 3장의 보조 이미지를 만듭니다. 실제 공연 사진이 아닌 AI 연출 이미지로 명확히 표시됩니다.</p></div><button disabled={generatingImages || !profile.representativeImage || missingImageCount === 0} onClick={() => void generateMissingImages()}>{generatingImages ? <Loader2 className="spin" size={16} /> : <ImagePlus size={16} />} {missingImageCount ? `${missingImageCount}장 생성` : "기본 사진 충족"}</button></div>{generationNotice && <div className="notice warning">{generationNotice}</div>}<small>실제 업로드 사진 → 사용자가 승인한 웹 사진 → AI 연출 이미지 순으로 PPT에 배치됩니다. AI 이미지는 경력의 시각적 이해를 돕는 용도이며 실제 현장 증빙으로 사용하지 않습니다.</small></div>
    <div className="form-card"><div className="card-heading"><div><h2>대표 활동 사진 자동 검색</h2><p>키 없이 쓰는 Wikimedia와 연결된 네이버·Google·YouTube에서 실제 후보를 찾고, 동일 인물·화질·권리 검수를 통과한 사진만 최대 2장 선택합니다.</p></div><button disabled={searching || !profile.artistName || !profile.representativeImage} onClick={() => void searchArtistImages(false)}>{searching ? <Loader2 className="spin" size={16} /> : <Search size={16} />} 다시 검색</button></div>{!profile.representativeImage && <div className="empty-media">프로필 정보 단계의 사진 1 대표사진을 먼저 등록해 주세요.</div>}</div>
    {(searchNotice || candidates.length > 0) && <div className="form-card web-image-review"><div className="card-heading"><div><h2>웹 이미지 후보 검토</h2><p>{searchNotice}</p></div><div className="web-review-actions"><span>{candidates.filter((candidate) => candidate.recommended).length}개 추천</span>{candidates.some((candidate) => candidate.recommended && !externalImages.some((image) => image.sourceUrl === candidate.sourceUrl)) && <button onClick={addRecommendedImages}>안전 추천 자동 추가</button>}</div></div>{candidates.length > 0 && <div className="web-image-grid">{candidates.map((candidate) => { const added = externalImages.some((image) => image.sourceUrl === candidate.sourceUrl); const blocked = candidate.watermarkDetected || candidate.usageStatus === "blocked"; return <article className={candidate.recommended ? "recommended" : blocked ? "blocked" : ""} key={candidate.id}><div className="web-image-frame"><img src={candidate.dataUrl} alt={candidate.title} />{blocked && <span className="watermark-warning">사용 제외</span>}</div><div className="web-image-meta"><span>{candidate.source.toUpperCase()} · 관련도 {Math.round(candidate.relevanceScore * 100)} · 품질 {Math.round(candidate.qualityScore * 100)}</span><strong>{candidate.title}</strong><p>{candidate.reason}</p><div>{candidate.sourceUrl && <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">출처·권한 확인</a>}<button disabled={added || blocked} onClick={() => addExternalImage(candidate)}>{blocked ? "워터마크·권한 위험" : added ? "추가됨" : "PPT 사진으로 추가"}</button></div></div></article>; })}</div>}</div>}
    {externalImages.length > 0 && <div className="form-card web-photo-section"><div className="card-heading"><div><h2>추가한 보조 사진</h2><p>웹 사진은 출처를, AI 이미지는 생성 사실과 근거 경력을 PPT 메모에 남깁니다.</p></div></div><div className="external-image-list">{externalImages.map((image) => <article className={image.source === "ai" ? "generated" : ""} key={image.id}><img src={image.dataUrl} alt={image.title} /><div><strong>{image.title}</strong>{image.source === "ai" ? <><span className="ai-disclosure">AI 연출 이미지</span><small>{image.promptBasis || image.disclosure}</small></> : image.sourceUrl && <a href={image.sourceUrl} target="_blank" rel="noreferrer">{image.source.toUpperCase()} 출처·권한 확인</a>}</div><button aria-label="보조 이미지 삭제" onClick={() => update("externalImages", externalImages.filter((target) => target.id !== image.id))}><X size={14} /></button></article>)}</div></div>}
    <div className="form-card photo-placement-card"><div className="card-heading"><div><h2>PPT 페이지별 사진 배치</h2><p>현재 선택한 사진이 들어갈 위치와 아직 필요한 사진을 미리 확인할 수 있어요.</p></div></div><div className="photo-placement-grid">{photoPlacements.map((placement) => <article key={placement.page}><div><strong>{placement.page}</strong><p>{placement.guide}</p></div><div className={`photo-placement-slots slots-${placement.slots}`}>{Array.from({ length: placement.slots }, (_, index) => placement.assets[index] ? <img src={placement.assets[index].dataUrl} alt={`${placement.page} 배치 사진 ${index + 1}`} key={placement.assets[index].id} /> : <span key={index}>사진 필요</span>)}</div></article>)}</div><small>강점·주요 경력·연락 페이지는 가독성을 위해 사진 없이 텍스트 중심으로 구성합니다.</small></div>
    <div className="form-card"><div className="card-heading"><div><h2>디자인 템플릿</h2><p>활동 분야와 제출 목적에 어울리는 디자인을 골라보세요.</p></div></div><div className="template-grid">{designTemplates.map((item) => <button key={item.key} className={`template-card ${profile.templateKey === item.key ? "selected" : ""}`} onClick={() => update("templateKey", item.key)}><div className="template-art" style={{ background: item.palette.background, color: item.palette.text }}><span style={{ color: item.palette.accent }}>ARTIST</span><strong>PORT<br />FOLIO</strong><i style={{ background: item.palette.accent }} /></div><div><strong>{item.name}</strong><small>{item.description}</small></div>{profile.templateKey === item.key && <span className="template-check"><Check /></span>}</button>)}</div></div>
    <div className="form-card compact"><div className="form-grid"><label><span>페이지 수</span><select value={[5, 6, 8].includes(profile.pageCount) ? profile.pageCount : 6} onChange={(event) => update("pageCount", Number(event.target.value))}><option value={5}>5페이지 · 임팩트형</option><option value={6}>6페이지 · 기본형</option><option value={8}>8페이지 · 상세형</option></select></label><label><span>프로필 목적</span><select value={profile.purpose} onChange={(event) => update("purpose", event.target.value)}><option>공공기관 제안</option><option>기업 행사 제안</option><option>축제 섭외</option><option>공연장 제출</option></select></label></div></div>
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
    if (plan.type === "cover") return <div className="ai-preview-slide ai-cover has-image" key={planIndex}>{images[0] ? <img src={images[0]} alt="표지" /> : <div className="ai-photo-placeholder cover"><strong>PHOTO NEEDED</strong><span>{plan.imagePurpose || "얼굴이 선명한 세로 대표사진 · 반신 또는 전신"}</span></div>}<div className="ai-image-shade" /><div className="ai-slide-copy"><span>{plan.eyebrow}</span><h1>{plan.title}</h1><p>{plan.body}</p><small>{profile.primaryField} · {profile.region}</small></div></div>;
    if (plan.type === "gallery") {
      return <div className="ai-preview-slide ai-gallery single" key={planIndex}><div className="ai-gallery-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2>{plan.body && <p>{plan.body}</p>}</div>{images[0] ? <img src={images[0]} alt="대표 활동 장면" /> : <div className="ai-photo-placeholder"><strong>ONE STRONG IMAGE</strong><span>{plan.imagePurpose || "대표 활동을 한눈에 보여주는 사진 한 장"}</span></div>}</div>;
    }
    if (plan.type === "strengths") return <div className="ai-preview-slide ai-strengths" key={planIndex}><span>{plan.eyebrow}</span><h2>{plan.title}</h2><div>{plan.bullets.slice(0, 3).map((item, index) => <article key={index}><small>0{index + 1}</small><strong>{item}</strong></article>)}</div></div>;
    if (plan.type === "career") {
      const visibleCareers = careers.slice(0, 10);
      const twoColumns = visibleCareers.length > 5;
      return <div className={`ai-preview-slide ai-career ${twoColumns ? "two-column" : ""}`} key={planIndex}><span>{plan.eyebrow}</span><h2>{plan.title}</h2><div className="career-list">{visibleCareers.map((item) => { const display = formatCareerFact(item, twoColumns); return <div className="preview-career" key={item.id}><b>{display.date}</b><strong>{display.title}</strong>{display.meta && <small>{display.meta}</small>}</div>; })}</div></div>;
    }
    if (plan.type === "contact") {
      const contactText = profile.contact || plan.bullets.find((item) => !/^https?:\/\//i.test(item)) || "연락 가능한 전화번호 또는 이메일을 입력해 주세요";
      const videoUrl = normalizeVideoUrl(profile.videoUrl || profile.officialUrl || plan.bullets.find((item) => /^https?:\/\//i.test(item)) || "");
      return <div className="ai-preview-slide ai-contact" key={planIndex}><span>BOOKING & CONTACT</span><h2>{plan.title || "공연·행사 섭외를 문의해 주세요"}</h2><p>{plan.body || [profile.primaryField, profile.purpose, profile.region].filter(Boolean).join(" · ")}</p><div><article><small>CONTACT</small><strong>{contactText}</strong></article>{videoUrl && <article className="preview-video-row"><small>VIDEO</small><a href={videoUrl} target="_blank" rel="noreferrer"><b>▶</b>{isYouTubeVideoUrl(videoUrl) ? "YouTube 대표 영상 바로 보기" : "대표 영상 바로 보기"}</a></article>}</div><em>일정과 행사 정보를 보내주시면 맞춤 구성으로 답변드리겠습니다.</em></div>;
    }
    const imageOnLeft = plan.layout === "split_left";
    return <div className={`ai-preview-slide ai-split has-image ${imageOnLeft ? "image-left" : "image-right"}`} key={planIndex}>{images[0] ? <img src={images[0]} alt="소개 이미지" /> : <div className="ai-photo-placeholder split"><strong>PHOTO NEEDED</strong><span>{plan.imagePurpose || "작업 또는 연주 중인 자연스러운 가로 사진 · 3:2 권장"}</span></div>}<div className="ai-slide-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2><p>{plan.body}</p>{plan.bullets.length > 0 && <ul>{plan.bullets.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div></div>;
  });
  const visibleSlides = slides.length ? slides : [<div className="ai-preview-slide ai-cover" key="empty"><div className="ai-slide-copy"><span>ARTIST PROFILE</span><h1>{profile.artistName}</h1><p>{profile.tagline}</p></div></div>];
  const activePlan = plans[slide];
  const isAiPlan = profile.deckPlanMeta?.mode === "ai";
  return <section className="preview-page"><div className="preview-top"><div><span>05 · 완성</span><h1>{isAiPlan ? "Gemini가 구성한 프로필입니다" : "기본 구성으로 만든 프로필입니다"}</h1><p>현재 미리보기와 다운로드되는 PPTX는 같은 페이지 기획·문구·사진 배치를 사용합니다.</p></div><div className="preview-actions"><button className="button ghost" onClick={onEdit}><PenLine size={16} /> 내용 수정</button>{!isAiPlan && <button className="button ghost" disabled={busy} onClick={() => void onRetry()}><RotateCcw size={16} /> Gemini 다시 시도</button>}<button className="button primary" disabled={busy} onClick={() => void onDownload()}>{busy ? <Loader2 className="spin" size={17} /> : <Download size={17} />} {busy ? "PPTX 제작 중" : "이 구성으로 PPTX 다운로드"}</button></div></div>
    {notice && <div className={`notice ${notice.includes("문제가") || notice.includes("기본 구성") ? "warning" : "success"}`}>{notice}</div>}
    <div className="preview-workspace"><div className="slide-rail">{visibleSlides.map((item, index) => { const plan = plans[index]; const image = plan?.imageRefs[0] ? getDeckAssetData(profile, plan.imageRefs[0]) : ""; return <button className={slide === index ? "selected" : ""} onClick={() => setSlide(index)} key={index}><span>{index + 1}</span><div style={{ background: image ? `linear-gradient(#0007,#0007),url(${image}) center/cover` : p.background, color: p.text }}>{plan?.title || profile.artistName || "ARTIST"}</div></button>; })}</div><div className="canvas-wrap"><div className="slide-canvas ai-plan-canvas" style={{ background: slide % 2 ? p.surface : p.background, color: p.text, "--accent": p.accent, "--muted": p.muted } as React.CSSProperties}>{visibleSlides[slide]}</div>{activePlan?.imagePurpose && <small className="image-purpose">사진 역할 · {activePlan.imagePurpose}</small>}<div className="canvas-controls"><button onClick={() => setSlide(Math.max(0, slide - 1))}><ArrowLeft /></button><span>{slide + 1} / {visibleSlides.length}</span><button onClick={() => setSlide(Math.min(visibleSlides.length - 1, slide + 1))}><ArrowRight /></button></div></div></div>
    <div className="completion-grid"><article><CheckCircle2 /><div><strong>수정 가능한 PPTX</strong><p>텍스트와 도형을 파워포인트에서 직접 편집할 수 있어요.</p></div></article><article><LayoutTemplate /><div><strong>{template.name}</strong><p>{profile.pageCount}페이지 구성에 맞춰 자동 배치됩니다.</p></div></article><article><RotateCcw /><div><strong>초안 자동 저장</strong><p>브라우저에서 언제든 이어서 수정할 수 있어요.</p></div></article></div></section>;
}
