"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, CircleHelp, Download, FileText,
  ImagePlus, LayoutTemplate, Loader2, Menu, PenLine, Plus, RotateCcw, Sparkles, Trash2, Upload, WandSparkles, X,
} from "lucide-react";
import { ExtractedItem, initialProfile, PdfPageAsset, ProfileData, SourceType } from "@/types/profile";
import { designTemplates, getTemplate } from "@/features/design-templates/registry/templates";
import { FILE_LIMITS } from "@/config/file-limits";
import { downloadPptx, getDeckAssetData, prepareDeckPlan } from "@/features/profile-export/pptx/generate-pptx";
import { buildDeckFacts } from "@/features/profile-export/pptx/deck-facts";
import { clearProfileDraft, loadProfileDraft, saveProfileDraft } from "@/features/profile-source/services/draft-storage";
import { analyzePdfInBrowser } from "@/features/pdf-import/services/analyze-pdf-browser";
import { inferItemsFromText } from "@/features/pdf-import/parsers/extract-items";

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
  };
  provider: "gemini" | "openai";
  model: string;
}

interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
}

const fields = ["보컬", "연주", "국악", "무용", "퍼포먼스", "마술", "진행·MC", "복합예술", "전통예술", "기타"];
const strengths = ["전문적인 실력", "관객과의 소통", "밝고 즐거운 분위기", "감성적인 분위기", "입장하고 화려한 무대", "전통과 현대의 조화", "가족 모두가 즐길 수 있음", "교육적 요소", "독특한 콘셉트"];
const experiences = ["기업행사", "공공기관 행사", "지역축제", "학교 행사", "문화재단 공연", "거리공연", "방송·미디어", "해외공연", "아직 공식 경력은 많지 않음"];
const impressions = ["실력이 뛰어나다", "믿을 수 있다", "행사를 잘 이해한다", "관객 반응이 좋다", "밝고 친근하다", "고급스럽다", "독창적이다", "전통성이 있다", "급한 일정에도 대응할 수 있다"];
const steps = ["시작", "자료 준비", "프로필 정보", "콘텐츠", "디자인", "완성"];

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

function toggleInList(list: string[], value: string, limit = 99) {
  if (list.includes(value)) return list.filter((item) => item !== value);
  return list.length >= limit ? list : [...list, value];
}

export default function ProfileStudio() {
  const [profile, setProfile] = useState<ProfileData>(initialProfile);
  const [step, setStep] = useState(0);
  const [pdfName, setPdfName] = useState("");
  const [pdfProgress, setPdfProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [unsureChoice, setUnsureChoice] = useState("");
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

  const update = <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => setProfile((current) => ({ ...current, [key]: value }));

  const selectSource = (source: SourceType) => {
    update("source", source);
    if (source === "questionnaire") setStep(2);
    else setStep(1);
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
      let finalItems = data.items;
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
          finalItems = result.items;
          aiProfile = result.profile;
          aiMode = true;
          aiProvider = result.provider === "gemini" ? "Gemini" : "OpenAI";
          aiModel = result.model || "";
        }
      } catch {
        // AI 호출이 실패해도 OCR·규칙 기반 결과로 계속 진행합니다.
      }
      const name = aiProfile?.artistName || finalItems.find((item) => item.type === "artist_name")?.value;
      const careers = aiProfile?.facts?.length
        ? aiProfile.facts.map((fact) => ({
            id: crypto.randomUUID(),
            year: fact.date,
            title: fact.title || fact.description,
            organization: [fact.organization, fact.location, fact.pageNumber ? `${fact.pageNumber}p` : ""].filter(Boolean).join(" · "),
          }))
        : itemsToCareers(finalItems);
      setProfile((current) => ({
        ...current,
        artistName: name || current.artistName,
        artistType: aiProfile?.artistType && aiProfile.artistType !== "알 수 없음" ? aiProfile.artistType : current.artistType,
        primaryField: aiProfile?.primaryField ? normalizeField(aiProfile.primaryField) : current.primaryField,
        secondaryField: aiProfile?.secondaryFields.join(", ") || current.secondaryField,
        region: aiProfile?.region || current.region,
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
        ? `${aiProvider} · ${aiModel} 원본 PDF 정밀 분석 완료: 연혁을 포함해 ${finalItems.length}개 항목을 찾았어요. 원문과 대조해 승인해 주세요.`
        : data.warnings?.length
        ? `PDF를 부분 분석했습니다. ${data.warnings[0]}`
        : data.analysisMode === "browser"
          ? "서버 대신 브라우저에서 PDF 분석을 완료했어요. 페이지 이미지와 OCR 결과를 확인해 주세요."
        : data.ocrPageCount > 0
          ? `이미지형 ${data.ocrPageCount}개 페이지를 OCR로 읽었어요. AI 키를 연결하면 페이지 이미지까지 정밀 분석합니다.`
          : "기본 분석을 완료했어요. AI 키를 연결하면 연혁과 고유명사를 더 정밀하게 분류합니다.");
      setPdfProgress(100);
      setTimeout(() => setStep(2), 450);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF 분석에 실패했습니다.");
      setPdfProgress(0);
    } finally { clearInterval(timer); setBusy(false); }
  };

  const uploadImage = (event: ChangeEvent<HTMLInputElement>, representative = false) => {
    const files = Array.from(event.target.files || []);
    files.forEach((file) => {
      if (!file.type.startsWith("image/") || file.size > FILE_LIMITS.image) return;
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result);
        if (representative) update("representativeImage", value);
        else setProfile((current) => ({ ...current, performanceImages: [...current.performanceImages, value].slice(0, FILE_LIMITS.maxPerformanceImages) }));
      };
      reader.readAsDataURL(file);
    });
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
    setNotice("Gemini가 지금까지 입력한 내용과 사진을 페이지별로 구성하고 있어요.");
    try {
      const prepared = await prepareDeckPlan(profile);
      setProfile((current) => ({ ...current, pageCount: prepared.plan.slides.length, deckPlan: prepared.plan, deckPlanMeta: prepared.meta }));
      setNotice(prepared.meta.mode === "ai"
        ? `${prepared.meta.provider} · ${prepared.meta.model}이 ${prepared.plan.slides.length}페이지를 구성했어요. 품질 검사 ${prepared.meta.qualityScore ?? 90}점 · 근거 ${prepared.meta.coveredFactCount ?? 0}/${prepared.meta.totalFactCount ?? 0}개 반영.`
        : "Gemini 기획을 사용할 수 없어 기본 페이지 구성으로 미리보기를 만들었어요.");
      setStep(5);
    } catch {
      setNotice("PPT 페이지 기획 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const resetDraft = () => {
    void clearProfileDraft(); setProfile(initialProfile); setStep(0); setPdfName(""); setNotice("");
  };

  const canContinue = step === 2 ? Boolean(profile.artistName && profile.primaryField) : step === 3 ? Boolean(profile.introduction) : true;

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setStep(0)} aria-label="홈으로"><span className="brand-mark">A</span><span>ARTFOLIO</span></button>
        <nav><button>프로필 제작</button><Link href="/admin/design-templates">디자인 관리</Link><button onClick={resetDraft}>새로 시작</button></nav>
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

      {step === 0 && <SourceStep onSelect={selectSource} />}
      {step === 1 && profile.source === "pdf" && <PdfStep name={pdfName} progress={pdfProgress} busy={busy} notice={notice} aiStatus={aiStatus} onUpload={uploadPdf} />}
      {step === 1 && profile.source === "unsure" && <UnsureStep value={unsureChoice} setValue={setUnsureChoice} onContinue={() => selectSource(["PDF 프로필", "한글·워드 이력서", "공연 포스터"].includes(unsureChoice) ? "pdf" : "questionnaire")} />}
      {step === 2 && <InformationStep profile={profile} update={update} setProfile={setProfile} notice={notice} />}
      {step === 3 && <ContentStep profile={profile} update={update} busy={busy} generate={generateCopy} notice={notice} />}
      {step === 4 && <DesignStep profile={profile} update={update} uploadImage={uploadImage} />}
      {step === 5 && <PreviewStep profile={profile} template={template} busy={busy} notice={notice} onEdit={() => setStep(3)} onDownload={exportDeck} />}

      {step >= 2 && step < 5 && (
        <footer className="action-bar">
          <button className="button ghost" onClick={() => setStep(step - 1)}><ArrowLeft size={17} /> 이전</button>
          <div><span>{step + 1} / 6</span><button className="button primary" disabled={!canContinue || busy} onClick={() => step === 4 ? void prepareDeck() : setStep(step + 1)}>{step === 4 && busy ? <><Loader2 className="spin" size={17} /> Gemini가 PPT 구성 중</> : <>다음 단계 <ArrowRight size={17} /></>}</button></div>
        </footer>
      )}
    </main>
  );
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
    <div className={`notice ${aiStatus.configured ? "success" : "warning"}`}>{aiStatus.configured ? `AI 연결됨 · ${aiStatus.provider} · ${aiStatus.model}` : "AI 미연결 · 현재는 OCR 기본 분석만 사용합니다. 배포 환경의 API 키를 확인해 주세요."}</div>
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

function InformationStep({ profile, update, setProfile, notice }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void; setProfile: React.Dispatch<React.SetStateAction<ProfileData>>; notice: string }) {
  const extracted = profile.extractedItems;
  return <section className="stage form-stage"><div className="section-heading"><span>02 · 프로필 정보</span><h1>{extracted.length ? "추출된 내용을 확인해 주세요" : "예술인에 대해 알려주세요"}</h1><p>{extracted.length ? "PDF에서 찾은 정보입니다. 수정하거나 제외한 뒤 프로필에 반영할 수 있어요." : "긴 글 대신 꼭 필요한 정보만 입력하면 됩니다."}</p></div>
    {notice && <div className={`notice ${notice.includes("부분 분석") ? "warning" : "success"}`}>{notice}</div>}
    {profile.pdfPageAssets.length > 0 && <div className="form-card pdf-assets-card"><div className="card-heading"><div><h2>PDF 이미지 자산</h2><p>스캔본을 포함한 모든 페이지를 이미지로 보존했습니다. 프로필에 재사용할 페이지를 선택하세요.</p></div><span>{profile.pdfPageAssets.filter((asset) => asset.selected).length}개 선택</span></div><div className="pdf-page-grid">{profile.pdfPageAssets.map((asset) => <article className={asset.selected ? "selected" : ""} key={asset.pageNumber}><button className="pdf-page-preview" onClick={() => setProfile((current) => ({ ...current, pdfPageAssets: current.pdfPageAssets.map((page) => page.pageNumber === asset.pageNumber ? { ...page, selected: !page.selected } : page) }))}><img src={asset.previewDataUrl} alt={`PDF ${asset.pageNumber}페이지`} /><span>{asset.selected ? <Check size={14} /> : <Plus size={14} />}</span></button><div><strong>{asset.pageNumber}페이지</strong><small className={asset.textSource}>{asset.textSource === "ocr" ? `OCR ${Math.round(asset.confidence * 100)}%` : asset.textSource === "embedded" ? "텍스트 포함" : "이미지 자산"}</small></div></article>)}</div></div>}
    {extracted.length > 0 && <div className="review-panel"><div className="review-title"><h2>AI·PDF 분석 결과</h2><span>{extracted.length}개 항목</span></div>{extracted.map((item) => <div className="review-item" key={item.id}><div className={`confidence ${item.confidence < .7 ? "low" : ""}`}>{Math.round(item.confidence * 100)}%</div><label><span>{item.label}{item.pageNumber ? ` · ${item.pageNumber}p` : ""}</span><textarea value={item.value} disabled={item.status === "excluded"} onChange={(event) => setProfile((current) => ({ ...current, extractedItems: current.extractedItems.map((target) => target.id === item.id ? { ...target, value: event.target.value, status: "edited" } : target) }))} /></label><button className={item.status === "excluded" ? "excluded" : ""} onClick={() => setProfile((current) => ({ ...current, extractedItems: current.extractedItems.map((target) => target.id === item.id ? { ...target, status: target.status === "excluded" ? "approved" : "excluded" } : target) }))}>{item.status === "excluded" ? "복원" : "제외"}</button></div>)}</div>}
    <div className="form-card"><h2>기본 정보</h2><div className="form-grid"><label><span>활동명 *</span><input value={profile.artistName} onChange={(event) => update("artistName", event.target.value)} placeholder="예: 김아름 / 아트밴드" /></label><label><span>활동 형태 *</span><div className="segmented"><button className={profile.artistType === "개인" ? "selected" : ""} onClick={() => update("artistType", "개인")}>개인</button><button className={profile.artistType === "단체" ? "selected" : ""} onClick={() => update("artistType", "단체")}>단체</button></div></label><label><span>주 활동 분야 *</span><select value={profile.primaryField} onChange={(event) => update("primaryField", event.target.value)}><option value="">선택해 주세요</option>{fields.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>주요 활동 지역</span><input value={profile.region} onChange={(event) => update("region", event.target.value)} placeholder="예: 서울·경기 / 전국" /></label><label><span>연락 방법</span><input value={profile.contact} onChange={(event) => update("contact", event.target.value)} placeholder="이메일 또는 전화번호" /></label><label><span>대표 영상 링크</span><input value={profile.videoUrl} onChange={(event) => update("videoUrl", event.target.value)} placeholder="https://" /></label></div></div>
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

function DesignStep({ profile, update, uploadImage }: { profile: ProfileData; update: <K extends keyof ProfileData>(key: K, value: ProfileData[K]) => void; uploadImage: (event: ChangeEvent<HTMLInputElement>, representative?: boolean) => void }) {
  return <section className="stage form-stage"><div className="section-heading"><span>04 · 디자인</span><h1>사진과 디자인을 선택해 주세요</h1><p>대표 사진과 프로필 분위기를 결정하면 실제 PPT와 같은 구성으로 미리보기를 만듭니다.</p></div>
    {profile.pdfPageAssets.some((asset) => asset.selected) && <div className="form-card"><div className="card-heading"><div><h2>PDF에서 선택한 자산</h2><p>원본 페이지 이미지를 대표 사진이나 공연 자료로 가져올 수 있어요.</p></div></div><div className="selected-pdf-assets">{profile.pdfPageAssets.filter((asset) => asset.selected).map((asset) => <article key={asset.pageNumber}><img src={asset.previewDataUrl} alt={`선택한 PDF ${asset.pageNumber}페이지`} /><strong>{asset.pageNumber}페이지</strong><div><button onClick={() => update("representativeImage", asset.previewDataUrl)}>대표 이미지</button><button onClick={() => !profile.performanceImages.includes(asset.previewDataUrl) && update("performanceImages", [...profile.performanceImages, asset.previewDataUrl].slice(0, FILE_LIMITS.maxPerformanceImages))}>공연 자료 추가</button></div></article>)}</div></div>}
    <div className="form-card"><div className="card-heading"><div><h2>대표 사진</h2><p>표지와 소개 페이지에 사용할 사진입니다.</p></div></div><div className="media-grid"><label className="image-upload">{profile.representativeImage ? <img src={profile.representativeImage} alt="대표 사진" /> : <><ImagePlus /><strong>대표 사진 올리기</strong><small>JPG, PNG · 최대 12MB</small></>}<input type="file" accept="image/*" onChange={(event) => uploadImage(event, true)} /></label><div className="photo-tip"><Sparkles /><strong>좋은 대표 사진은 이렇게 골라보세요</strong><p>인물이 선명하고 위아래 여백이 있는 세로 사진이 여러 레이아웃에 잘 어울립니다.</p></div></div></div>
    <div className="form-card"><div className="card-heading"><div><h2>공연 사진</h2><p>최대 8장까지 추가할 수 있어요.</p></div><label className="mini-upload"><Plus size={16} /> 사진 추가<input type="file" accept="image/*" multiple onChange={(event) => uploadImage(event)} /></label></div>{profile.performanceImages.length ? <div className="thumb-row">{profile.performanceImages.map((image, index) => <div key={index}><img src={image} alt={`공연 사진 ${index + 1}`} /><button onClick={() => update("performanceImages", profile.performanceImages.filter((_, target) => target !== index))}><X size={13} /></button></div>)}</div> : <div className="empty-media">공연 사진을 추가하면 갤러리 페이지에 반영됩니다.</div>}</div>
    <div className="form-card"><div className="card-heading"><div><h2>디자인 템플릿</h2><p>활동 분야와 제출 목적에 어울리는 디자인을 골라보세요.</p></div></div><div className="template-grid">{designTemplates.map((item) => <button key={item.key} className={`template-card ${profile.templateKey === item.key ? "selected" : ""}`} onClick={() => update("templateKey", item.key)}><div className="template-art" style={{ background: item.palette.background, color: item.palette.text }}><span style={{ color: item.palette.accent }}>ARTIST</span><strong>PORT<br />FOLIO</strong><i style={{ background: item.palette.accent }} /></div><div><strong>{item.name}</strong><small>{item.description}</small></div>{profile.templateKey === item.key && <span className="template-check"><Check /></span>}</button>)}</div></div>
    <div className="form-card compact"><div className="form-grid"><label><span>페이지 수</span><select value={profile.pageCount} onChange={(event) => update("pageCount", Number(event.target.value))}><option value={4}>4페이지 · 핵심형</option><option value={6}>6페이지 · 기본형</option><option value={8}>8페이지 · 상세형</option><option value={10}>10페이지 · 포트폴리오형</option></select></label><label><span>프로필 목적</span><select value={profile.purpose} onChange={(event) => update("purpose", event.target.value)}><option>공공기관 제안</option><option>기업 행사 제안</option><option>축제 섭외</option><option>공연장 제출</option></select></label></div></div>
  </section>;
}

function PreviewStep({ profile, template, busy, notice, onEdit, onDownload }: { profile: ProfileData; template: ReturnType<typeof getTemplate>; busy: boolean; notice: string; onEdit: () => void; onDownload: () => Promise<void> }) {
  const [slide, setSlide] = useState(0);
  const p = template.palette;
  const plans = profile.deckPlan?.slides ?? [];
  const deckFacts = buildDeckFacts(profile);
  const slides = plans.map((plan, planIndex) => {
    const images = plan.imageRefs.map((id) => getDeckAssetData(profile, id)).filter((value): value is string => Boolean(value));
    const careers = plan.careerIndexes.map((index) => deckFacts[index]).filter(Boolean);
    if (plan.type === "cover") return <div className={`ai-preview-slide ai-cover ${images[0] ? "has-image" : ""}`} key={planIndex}>{images[0] && <img src={images[0]} alt="표지" />}<div className="ai-image-shade" /><div className="ai-slide-copy"><span>{plan.eyebrow}</span><h1>{plan.title}</h1><p>{plan.body}</p><small>{profile.primaryField} · {profile.region}</small></div></div>;
    if (plan.type === "gallery") return <div className="ai-preview-slide ai-gallery" key={planIndex}><span>{plan.eyebrow}</span><h2>{plan.title}</h2><div className={`ai-gallery-grid count-${Math.min(3, images.length)}`}>{images.slice(0, 3).map((image, index) => <img src={image} alt={`공연 이미지 ${index + 1}`} key={index} />)}</div></div>;
    if (plan.type === "strengths") return <div className="ai-preview-slide ai-strengths" key={planIndex}><span>{plan.eyebrow}</span><h2>{plan.title}</h2><div>{plan.bullets.slice(0, 3).map((item, index) => <article key={index}><small>0{index + 1}</small><strong>{item}</strong></article>)}</div></div>;
    if (plan.type === "career") return <div className="ai-preview-slide ai-career" key={planIndex}><span>{plan.eyebrow}</span><h2>{plan.title}</h2>{careers.slice(0, 8).map((item) => <div className="preview-career" key={item.id}><b>{item.date || "—"}</b><strong>{item.title}</strong><small>{[item.categoryLabel, item.organization, item.pageNumber ? `${item.pageNumber}p` : ""].filter(Boolean).join(" · ")}</small></div>)}</div>;
    const imageOnLeft = plan.layout === "split_left";
    return <div className={`ai-preview-slide ai-split ${images[0] ? "has-image" : ""} ${imageOnLeft ? "image-left" : "image-right"}`} key={planIndex}>{images[0] && <img src={images[0]} alt={plan.type === "contact" ? "연락 페이지 이미지" : "소개 이미지"} />}<div className="ai-slide-copy"><span>{plan.eyebrow}</span><h2>{plan.title}</h2><p>{plan.body}</p>{plan.bullets.length > 0 && <ul>{plan.bullets.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div></div>;
  });
  const visibleSlides = slides.length ? slides : [<div className="ai-preview-slide ai-cover" key="empty"><div className="ai-slide-copy"><span>ARTIST PROFILE</span><h1>{profile.artistName}</h1><p>{profile.tagline}</p></div></div>];
  const activePlan = plans[slide];
  return <section className="preview-page"><div className="preview-top"><div><span>05 · 완성</span><h1>Gemini가 구성한 프로필입니다</h1><p>현재 미리보기와 다운로드되는 PPTX는 같은 페이지 기획·문구·사진 배치를 사용합니다.</p></div><div className="preview-actions"><button className="button ghost" onClick={onEdit}><PenLine size={16} /> 내용 수정</button><button className="button primary" disabled={busy} onClick={() => void onDownload()}>{busy ? <Loader2 className="spin" size={17} /> : <Download size={17} />} {busy ? "PPTX 제작 중" : "이 구성으로 PPTX 다운로드"}</button></div></div>
    {notice && <div className={`notice ${notice.includes("문제가") || notice.includes("기본 구성") ? "warning" : "success"}`}>{notice}</div>}
    <div className="preview-workspace"><div className="slide-rail">{visibleSlides.map((item, index) => { const plan = plans[index]; const image = plan?.imageRefs[0] ? getDeckAssetData(profile, plan.imageRefs[0]) : ""; return <button className={slide === index ? "selected" : ""} onClick={() => setSlide(index)} key={index}><span>{index + 1}</span><div style={{ background: image ? `linear-gradient(#0007,#0007),url(${image}) center/cover` : p.background, color: p.text }}>{plan?.title || profile.artistName || "ARTIST"}</div></button>; })}</div><div className="canvas-wrap"><div className="slide-canvas ai-plan-canvas" style={{ background: slide % 2 ? p.surface : p.background, color: p.text, "--accent": p.accent, "--muted": p.muted } as React.CSSProperties}>{visibleSlides[slide]}</div>{activePlan?.imagePurpose && <small className="image-purpose">사진 역할 · {activePlan.imagePurpose}</small>}<div className="canvas-controls"><button onClick={() => setSlide(Math.max(0, slide - 1))}><ArrowLeft /></button><span>{slide + 1} / {visibleSlides.length}</span><button onClick={() => setSlide(Math.min(visibleSlides.length - 1, slide + 1))}><ArrowRight /></button></div></div></div>
    <div className="completion-grid"><article><CheckCircle2 /><div><strong>수정 가능한 PPTX</strong><p>텍스트와 도형을 파워포인트에서 직접 편집할 수 있어요.</p></div></article><article><LayoutTemplate /><div><strong>{template.name}</strong><p>{profile.pageCount}페이지 구성에 맞춰 자동 배치됩니다.</p></div></article><article><RotateCcw /><div><strong>초안 자동 저장</strong><p>브라우저에서 언제든 이어서 수정할 수 있어요.</p></div></article></div></section>;
}
