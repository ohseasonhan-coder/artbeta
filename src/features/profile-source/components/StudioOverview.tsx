import { ArrowUpRight, Check, FileText, ImagePlus, LayoutTemplate } from "lucide-react";
import type { ProfileData } from "@/types/profile";

/** A deliberately typographic sample: never presents invented artist credentials. */
export function PortfolioSample() {
  return <aside className="portfolio-sample" aria-label="포트폴리오 디자인 예시">
    <div className="sample-caption"><span>YOUR NEXT STAGE</span><span>DESIGN PREVIEW</span></div>
    <div className="sample-deck">
      <div className="sample-cover"><span>ARTIST PORTFOLIO / 01</span><div className="sample-orbit" aria-hidden="true" /><h2>당신의 무대를<br />다음 기회로.</h2><p>이야기가 있는 소개.<br />기억에 남는 포트폴리오.</p><footer><span>ARTFOLIO STUDIO</span><ArrowUpRight size={24} /></footer></div>
      <div className="sample-index"><span>SELECTED WORKS</span><strong>경험이<br />설득력이 되도록.</strong><div><span>01</span> 아티스트 소개</div><div><span>02</span> 주요 활동과 경력</div><div><span>03</span> 대표 장면과 섭외 문의</div></div>
    </div>
    <div className="sample-caption bottom"><span>편집 가능한 텍스트 · 16:9 와이드</span><span>디자인 예시</span></div>
  </aside>;
}

export function StudioJourney() {
  const items = [
    { icon: FileText, title: "자료를 한곳에", text: "기존 소개서, 사진, 활동 링크를 모아주세요." },
    { icon: ImagePlus, title: "중요한 내용만 확인", text: "활동 이력과 사진을 살펴보고 수정하세요." },
    { icon: LayoutTemplate, title: "나만의 PPT로 완성", text: "페이지를 검토하고 편집 가능한 파일로 받으세요." },
  ];
  return <div className="studio-journey">{items.map(({ icon: Icon, title, text }, index) => <article key={title}><span className="journey-number">0{index + 1}</span><Icon size={21} /><h2>{title}</h2><p>{text}</p></article>)}</div>;
}

export function PortfolioReadiness({ profile }: { profile: ProfileData }) {
  const items = [
    { label: "활동명", ready: !!profile.artistName.trim(), hint: "누구의 포트폴리오인지 알려주세요." },
    { label: "소개", ready: !!profile.introduction.trim(), hint: "활동 분야와 특징을 2~3문장으로 적어주세요." },
    { label: "대표사진", ready: !!profile.representativeImage, hint: "선명한 대표사진으로 첫인상을 완성하세요." },
    { label: "활동 근거", ready: profile.careers.some(item => !!item.title.trim()) || profile.extractedItems.some(item => item.status !== "excluded" && ["career", "performance", "award", "media"].includes(item.type)), hint: "공연·전시·수상 등 실제 활동을 추가하세요." },
    { label: "연락처", ready: !!profile.contact.trim(), hint: "제안을 받을 이메일이나 전화번호를 적어주세요." },
  ];
  const completed = items.filter(item => item.ready).length;
  return <section className="portfolio-readiness" aria-label="포트폴리오 준비 상태"><header><div><span>PORTFOLIO CHECKLIST</span><h2>좋은 포트폴리오의 기본 재료</h2></div><strong>{completed}<small> / {items.length}</small></strong></header><div className="readiness-track" role="progressbar" aria-label="기본 자료 준비" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={completed}><span style={{ width: `${completed / items.length * 100}%` }} /></div><div className="readiness-items">{items.map(item => <span key={item.label} className={item.ready ? "ready" : ""}>{item.ready ? <Check size={14} /> : <span className="readiness-dot" />}{item.label}</span>)}</div>{completed < items.length && <p>{items.find(item => !item.ready)?.hint} 아래 세부 수정에서 보완할 수 있어요.</p>}</section>;
}
