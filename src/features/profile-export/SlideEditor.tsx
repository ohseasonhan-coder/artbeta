"use client";

import type { DeckPlan, DeckSlidePlan } from "@/types/profile";
import type { SceneAsset } from "./pptx/slide-scene";

export default function SlideEditor({ plan, index, assets, busy, onChange }: { plan: DeckPlan; index: number; assets: SceneAsset[]; busy: boolean; onChange: (plan: DeckPlan) => void }) {
  const slide = plan.slides[index];
  if (!slide) return null;
  const update = (patch: Partial<DeckSlidePlan>) => onChange({ ...plan, slides: plan.slides.map((item, i) => i === index ? { ...item, ...patch } : item) });
  const used = new Set(plan.slides.filter((_, i) => i !== index).flatMap(item => item.imageRefs));
  return <details className="slide-editor"><summary>{index + 1}페이지 직접 다듬기 <span>문구 · 사진 · 배치</span></summary><fieldset disabled={busy}>
    <p>변경사항은 미리보기에 바로 반영됩니다. 수정 후 ‘다시 자동 검수’를 실행하면 현재 구성을 검수합니다.</p>
    <div className="slide-editor-fields"><label>페이지 제목<input value={slide.title} onChange={event => update({ title: event.target.value })} /></label><label>본문<textarea rows={3} value={slide.body} onChange={event => update({ body: event.target.value })} /></label>{!["cover", "career", "contact", "gallery"].includes(slide.type) && <label>핵심 문구 · 한 줄에 하나씩<textarea rows={4} value={slide.bullets.join("\n")} onChange={event => update({ bullets: event.target.value.split("\n") })} /></label>}<label>사진 위치<select value={slide.layout === "split_left" ? "split_left" : "split_right"} disabled={slide.type === "cover"} onChange={event => update({ layout: event.target.value as DeckSlidePlan["layout"] })}><option value="split_right">오른쪽 사진</option><option value="split_left">왼쪽 사진</option></select>{slide.type === "cover" && <small>표지 사진 위치는 선택한 디자인을 따릅니다.</small>}</label></div>
    <strong>이 페이지에 사용할 사진</strong><div className="slide-photo-picker"><button type="button" aria-pressed={!slide.imageRefs.length} onClick={() => update({ imageRefs: [] })}>사진 없이 구성</button>{assets.map((asset, i) => <button type="button" key={asset.id} disabled={used.has(asset.id)} aria-label={`사진 ${i + 1}${used.has(asset.id) ? " · 다른 페이지에서 사용 중" : " 선택"}`} aria-pressed={slide.imageRefs.includes(asset.id)} onClick={() => update({ imageRefs: [asset.id] })}><img src={asset.dataUrl} alt={`사진 ${i + 1}`} /><span>{used.has(asset.id) ? "다른 페이지에서 사용" : slide.imageRefs.includes(asset.id) ? "선택한 사진" : `사진 ${i + 1}`}</span></button>)}</div>
  </fieldset></details>;
}
