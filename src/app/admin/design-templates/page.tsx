"use client";
import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, CheckCircle2, Copy, Eye, GripVertical, ImagePlus, MoreHorizontal, Plus, Search, SlidersHorizontal } from "lucide-react";
import { designTemplates } from "@/features/design-templates/registry/templates";

export default function TemplateAdminPage(){
 const [active,setActive]=useState<Record<string,boolean>>(Object.fromEntries(designTemplates.map(i=>[i.key,true]))); const [query,setQuery]=useState("");
 const visible=designTemplates.filter(i=>(i.name+i.category).toLowerCase().includes(query.toLowerCase()));
 return <main className="admin-shell"><aside className="admin-side"><Link className="admin-brand" href="/"><span>A</span> ARTFOLIO</Link><nav><small>WORKSPACE</small><Link href="/">프로필 제작</Link><a className="selected">디자인 템플릿</a><a>자산 라이브러리</a><small>MANAGEMENT</small><a>생성 파일</a><a>사용량</a></nav><div className="admin-user"><span>AD</span><div><strong>관리자</strong><small>admin@artfolio.kr</small></div></div></aside>
 <section className="admin-main"><header><div><Link href="/"><ArrowLeft/> 스튜디오</Link><h1>디자인 템플릿</h1><p>코드 수정 없이 프로필 디자인과 표시 순서를 관리합니다.</p></div><button><Plus/> 새 디자인 등록</button></header>
 <div className="admin-stats"><article><span>전체 템플릿</span><strong>{designTemplates.length}</strong><small>등록된 디자인</small></article><article><span>활성 디자인</span><strong>{Object.values(active).filter(Boolean).length}</strong><small><CheckCircle2/> 사용자에게 표시 중</small></article><article><span>이번 달 생성</span><strong>0</strong><small>데이터 연결 전</small></article></div>
 <div className="admin-toolbar"><label><Search/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="템플릿 이름 또는 카테고리 검색"/></label><button><SlidersHorizontal/> 필터</button><span>{visible.length}개 결과</span></div>
 <div className="admin-table"><div className="table-head"><span>순서</span><span>템플릿</span><span>분류</span><span>추천 용도</span><span>버전</span><span>상태</span><span/></div>{visible.map((item,index)=><div className="table-row" key={item.key}><span><GripVertical/> {index+1}</span><div className="template-cell"><div style={{background:item.palette.background,color:item.palette.text}}><b style={{color:item.palette.accent}}>A</b></div><div><strong>{item.name}</strong><small>{item.key}</small></div></div><span className="category-pill">{item.category}</span><span className="tag-list">{item.recommendedFor.slice(0,2).map(tag=><i key={tag}>{tag}</i>)}</span><span>v1.0</span><label className="switch"><input type="checkbox" checked={active[item.key]} onChange={()=>setActive(c=>({...c,[item.key]:!c[item.key]}))}/><i/></label><div className="row-actions"><button><Eye/></button><button><Copy/></button><button><MoreHorizontal/></button></div></div>)}</div>
 <div className="asset-guide"><ImagePlus/><div><strong>디자인 자산 저장 원칙</strong><p>배경·프레임·썸네일 원본은 외부 스토리지에 저장하고, 저장소에는 manifest와 경로만 남깁니다.</p></div><button>자산 구조 보기</button></div></section></main>;
}

