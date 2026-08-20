"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BriefcaseBusiness, CalendarDays, CheckCircle2, ChevronDown, CircleDollarSign, MapPin, Plus, Search, Sparkles, UserRoundSearch, UsersRound, X } from "lucide-react";
import { loadProfileDraft } from "@/features/profile-source/services/draft-storage";
import { useSiteSettings } from "@/features/site-settings/SiteSettingsProvider";
import type { ProfileData } from "@/types/profile";
import type { CompensationType, TeamPost, TeamPostInput, TeamPostType } from "@/types/team";

const LOCAL_POSTS_KEY = "artfolio-team-posts";
const EDIT_TOKENS_KEY = "artfolio-team-edit-tokens";
const fields = ["전체 분야", "보컬", "연주", "국악", "무용", "퍼포먼스", "마술", "진행·MC", "복합예술", "전통예술", "기타"];
const compensationLabels: Record<CompensationType, string> = { paid: "유급", negotiable: "협의", exchange: "재능교환", volunteer: "비영리" };

const demos: TeamPost[] = [
  { id: "demo-1", postType: "recruit", status: "open", title: "지역축제 무대를 함께할 타악 연주자를 찾습니다", artistName: "아트앙상블", primaryField: "국악", region: "서울·경기", wantedRole: "타악 연주자", headcount: 1, activityType: "단기 프로젝트", projectDate: "2026년 10월", compensation: "negotiable", description: "지역축제 공연을 함께 준비할 타악 연주자를 찾습니다. 리허설 일정은 참여자와 조율합니다.", highlights: ["지역문화축제 초청 공연", "전통과 현대를 결합한 창작 무대"], profileImage: "", profileUrl: "", contact: "프로필 확인 후 문의", createdAt: new Date().toISOString(), isDemo: true },
  { id: "demo-2", postType: "join", status: "open", title: "공연과 창작 프로젝트에 합류할 팀을 찾고 있어요", artistName: "김아트", primaryField: "무용", region: "부산", wantedRole: "현대무용수", headcount: 1, activityType: "정규 팀 활동", projectDate: "상시", compensation: "negotiable", description: "현대무용과 융복합 공연을 중심으로 꾸준히 활동할 팀을 찾고 있습니다.", highlights: ["창작공연 5회 참여", "지역문화재단 프로젝트 경험"], profileImage: "", profileUrl: "", contact: "Instagram DM", createdAt: new Date(Date.now() - 86400000).toISOString(), isDemo: true },
];

const blankInput: TeamPostInput = { postType: "recruit", title: "", artistName: "", primaryField: "", region: "", wantedRole: "", headcount: 1, activityType: "단기 프로젝트", projectDate: "", compensation: "negotiable", description: "", highlights: [], profileImage: "", profileUrl: "", contact: "", website: "" };

async function thumbnail(dataUrl?: string) {
  if (!dataUrl) return "";
  return new Promise<string>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const ratio = Math.min(1, 320 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.72));
    };
    image.onerror = () => resolve(""); image.src = dataUrl;
  });
}

function profileToInput(profile: ProfileData, image: string): TeamPostInput {
  const highlights = profile.careers.filter((career) => career.title.trim()).slice(0, 3).map((career) => [career.year, career.title].filter(Boolean).join(" · "));
  return { ...blankInput, artistName: profile.artistName, primaryField: profile.primaryField, region: profile.region, profileImage: image, profileUrl: profile.officialUrl || profile.videoUrl, contact: profile.contact, highlights, description: profile.introduction ? `${profile.introduction}\n\n함께할 분을 기다리고 있습니다.` : "함께 공연과 프로젝트를 만들어갈 분을 찾습니다." };
}

export default function TeamBoard() {
  const { config } = useSiteSettings();
  const [posts, setPosts] = useState<TeamPost[]>(demos);
  const [storage, setStorage] = useState<"loading" | "local" | "shared">("loading");
  const [query, setQuery] = useState("");
  const [field, setField] = useState("전체 분야");
  const [region, setRegion] = useState("전체 지역");
  const [postType, setPostType] = useState<"all" | TeamPostType>("all");
  const [mineOnly, setMineOnly] = useState(false);
  const [openForm, setOpenForm] = useState(false);
  const [form, setForm] = useState<TeamPostInput>(blankInput);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/team-posts").then((response) => response.json()),
      loadProfileDraft().catch(() => null),
    ]).then(async ([result, profile]) => {
      const mode = result.storage === "shared" ? "shared" : "local";
      setStorage(mode);
      if (mode === "shared" && result.posts?.length) setPosts(result.posts);
      if (mode === "local") {
        const saved = JSON.parse(localStorage.getItem(LOCAL_POSTS_KEY) || "[]") as TeamPost[];
        if (saved.length) setPosts([...saved, ...demos]);
      }
      if (profile) {
        setForm(profileToInput(profile, await thumbnail(profile.representativeImage)));
        setProfileLoaded(Boolean(profile.artistName));
      }
      if (result.warning) setNotice(result.warning);
    });
  }, []);

  const myIds = useMemo(() => new Set(Object.keys(JSON.parse(typeof window === "undefined" ? "{}" : localStorage.getItem(EDIT_TOKENS_KEY) || "{}"))), [posts]);
  const visiblePosts = useMemo(() => config.team.showDemoPosts ? posts : posts.filter((post) => !post.isDemo), [config.team.showDemoPosts, posts]);
  const regions = useMemo(() => ["전체 지역", ...Array.from(new Set(visiblePosts.map((post) => post.region).filter(Boolean)))], [visiblePosts]);
  const filtered = useMemo(() => visiblePosts.filter((post) => {
    const haystack = [post.title, post.artistName, post.primaryField, post.region, post.wantedRole, post.activityType, post.description, ...post.highlights].join(" ").toLowerCase();
    return (!query.trim() || haystack.includes(query.trim().toLowerCase())) && (field === "전체 분야" || post.primaryField === field) && (region === "전체 지역" || post.region === region) && (postType === "all" || post.postType === postType) && (!mineOnly || myIds.has(post.id));
  }).sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [visiblePosts, query, field, region, postType, mineOnly, myIds]);

  const savePost = async () => {
    if (![form.title, form.artistName, form.primaryField, form.region, form.wantedRole, form.description, form.contact].every((value) => String(value).trim())) return setNotice("제목·활동명·분야·지역·필요 역할·소개·연락 방법을 확인해 주세요.");
    setSaving(true); setNotice("");
    try {
      let created: TeamPost; let editToken = crypto.randomUUID();
      if (storage === "shared") {
        const response = await fetch("/api/team-posts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "모집글을 저장하지 못했습니다.");
        created = result.post; editToken = result.editToken;
      } else {
        created = { ...form, id: crypto.randomUUID(), status: "open", createdAt: new Date().toISOString() };
        const saved = [created, ...posts.filter((post) => !post.isDemo)];
        localStorage.setItem(LOCAL_POSTS_KEY, JSON.stringify(saved));
      }
      const tokens = JSON.parse(localStorage.getItem(EDIT_TOKENS_KEY) || "{}"); tokens[created.id] = editToken; localStorage.setItem(EDIT_TOKENS_KEY, JSON.stringify(tokens));
      setPosts((current) => [created, ...current]); setOpenForm(false); setMineOnly(true); setNotice("프로필을 연결한 모집글을 등록했습니다.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "모집글을 저장하지 못했습니다."); }
    finally { setSaving(false); }
  };

  const toggleStatus = async (post: TeamPost) => {
    const status = post.status === "open" ? "closed" : "open";
    const tokens = JSON.parse(localStorage.getItem(EDIT_TOKENS_KEY) || "{}");
    if (storage === "shared") {
      const response = await fetch("/api/team-posts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: post.id, editToken: tokens[post.id], status }) });
      if (!response.ok) return setNotice("모집 상태를 변경하지 못했습니다.");
    } else {
      const local = posts.filter((item) => !item.isDemo).map((item) => item.id === post.id ? { ...item, status } : item);
      localStorage.setItem(LOCAL_POSTS_KEY, JSON.stringify(local));
    }
    setPosts((current) => current.map((item) => item.id === post.id ? { ...item, status } : item));
  };

  return <main className="team-shell">
    <header className="team-topbar"><Link className="brand" href="/"><span className="brand-mark">{config.brand.mark}</span><span>{config.brand.name}</span></Link><nav><Link href="/">{config.navigation.studio}</Link><Link className="selected" href="/team">{config.navigation.team}</Link></nav><button onClick={() => setOpenForm(true)}><Plus size={15} /> {config.team.createLabel}</button></header>
    <section className="team-hero"><div><span><Sparkles size={14} /> {config.team.eyebrow}</span><h1>{config.team.title.split("\n").map((line, index) => <span key={`${line}-${index}`}>{line}{index < config.team.title.split("\n").length - 1 && <br />}</span>)}</h1><p>{config.team.description}</p></div><div className="team-hero-card"><UsersRound /><strong>{visiblePosts.filter((post) => post.status === "open").length}</strong><span>현재 모집·합류 글</span><small>{storage === "shared" ? "모든 사용자에게 공개 중" : "무료 기기 저장 체험 모드"}</small></div></section>
    <section className="team-board-wrap"><div className="team-tabs"><button className={postType === "all" && !mineOnly ? "selected" : ""} onClick={() => { setPostType("all"); setMineOnly(false); }}>전체</button><button className={postType === "recruit" && !mineOnly ? "selected" : ""} onClick={() => { setPostType("recruit"); setMineOnly(false); }}>팀원 구해요</button><button className={postType === "join" && !mineOnly ? "selected" : ""} onClick={() => { setPostType("join"); setMineOnly(false); }}>팀을 찾고 있어요</button><button className={mineOnly ? "selected" : ""} onClick={() => setMineOnly(true)}>내 글</button></div>
      <div className="team-filters"><label><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={config.team.searchPlaceholder} /></label><select value={field} onChange={(event) => setField(event.target.value)}>{fields.map((item) => <option key={item}>{item}</option>)}</select><select value={region} onChange={(event) => setRegion(event.target.value)}>{regions.map((item) => <option key={item}>{item}</option>)}</select></div>
      {notice && <div className="team-notice"><CheckCircle2 /> {notice}<button onClick={() => setNotice("")}><X /></button></div>}
      <div className="team-result-head"><div><strong>{filtered.length}개</strong>의 관련 글</div><span>모집 중인 글을 먼저 표시합니다</span></div>
      <div className="team-post-grid">{filtered.map((post) => <article className={`${post.status === "closed" ? "closed" : ""} ${expanded === post.id ? "expanded" : ""}`} key={post.id}><div className="team-profile-image">{post.profileImage ? <img src={post.profileImage} alt={`${post.artistName} 대표사진`} /> : <span>{post.artistName.slice(0, 1)}</span>}{post.isDemo && <b>예시</b>}</div><div className="team-post-copy"><div className="team-post-meta"><span>{post.postType === "recruit" ? "팀원 구해요" : "팀을 찾고 있어요"}</span><i>{post.status === "open" ? "모집 중" : "모집 완료"}</i></div><h2>{post.title}</h2><strong>{post.artistName}</strong><div className="team-tags"><span>{post.primaryField}</span><span><MapPin /> {post.region}</span><span><UserRoundSearch /> {post.wantedRole}</span><span><CircleDollarSign /> {compensationLabels[post.compensation]}</span></div>{expanded === post.id && <div className="team-post-detail"><p>{post.description}</p>{post.highlights.length > 0 && <ul>{post.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>}<div><span><CalendarDays /> {post.projectDate || "일정 협의"}</span><span><BriefcaseBusiness /> {post.activityType} · {post.headcount}명</span></div><strong>문의 방법 · {post.contact}</strong>{post.profileUrl && <a href={post.profileUrl} target="_blank" rel="noreferrer">공식 프로필·영상 보기 <ArrowRight /></a>}</div>}<div className="team-card-actions"><button onClick={() => setExpanded(expanded === post.id ? null : post.id)}>{expanded === post.id ? "접기" : "모집 내용 보기"} <ChevronDown /></button>{myIds.has(post.id) && <button onClick={() => void toggleStatus(post)}>{post.status === "open" ? "모집 완료로 변경" : "다시 모집하기"}</button>}</div></div></article>)}</div>
      {!filtered.length && <div className="team-empty"><UserRoundSearch /><h2>조건에 맞는 글이 아직 없습니다</h2><p>첫 모집글을 등록하거나 검색 조건을 줄여보세요.</p><button onClick={() => setOpenForm(true)}>프로필로 모집글 만들기</button></div>}
    </section>
    {openForm && <div className="team-modal" role="dialog" aria-modal="true" aria-label="모집글 작성"><div className="team-form"><header><div><span>{profileLoaded ? "현재 프로필 자동 연결됨" : "간단 모집글 작성"}</span><h2>팀원 모집·합류 글</h2></div><button onClick={() => setOpenForm(false)} aria-label="닫기"><X /></button></header><div className="team-type-switch"><button className={form.postType === "recruit" ? "selected" : ""} onClick={() => setForm({ ...form, postType: "recruit" })}>팀원 구해요</button><button className={form.postType === "join" ? "selected" : ""} onClick={() => setForm({ ...form, postType: "join" })}>팀을 찾고 있어요</button></div><div className="team-form-grid"><label className="wide"><span>제목</span><input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="예: 지역축제 무대를 함께할 연주자를 찾습니다" /></label><label><span>활동명</span><input value={form.artistName} onChange={(event) => setForm({ ...form, artistName: event.target.value })} /></label><label><span>분야</span><select value={form.primaryField} onChange={(event) => setForm({ ...form, primaryField: event.target.value })}><option value="">선택</option>{fields.slice(1).map((item) => <option key={item}>{item}</option>)}</select></label><label><span>{form.postType === "recruit" ? "필요한 역할" : "나의 역할"}</span><input value={form.wantedRole} onChange={(event) => setForm({ ...form, wantedRole: event.target.value })} placeholder="예: 타악 연주자" /></label><label><span>지역</span><input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="예: 서울·경기" /></label><label><span>활동 형태</span><select value={form.activityType} onChange={(event) => setForm({ ...form, activityType: event.target.value })}><option>단기 프로젝트</option><option>정규 팀 활동</option><option>공연 1회</option><option>창작·연구</option><option>온라인 협업</option></select></label><label><span>보상</span><select value={form.compensation} onChange={(event) => setForm({ ...form, compensation: event.target.value as CompensationType })}><option value="paid">유급</option><option value="negotiable">협의</option><option value="exchange">재능교환</option><option value="volunteer">비영리</option></select></label><label><span>일정</span><input value={form.projectDate} onChange={(event) => setForm({ ...form, projectDate: event.target.value })} placeholder="예: 2026년 10월 / 상시" /></label><label><span>인원</span><input type="number" min={1} max={30} value={form.headcount} onChange={(event) => setForm({ ...form, headcount: Number(event.target.value) })} /></label><label className="wide"><span>모집 내용</span><textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="활동 목적과 함께하고 싶은 분을 간단히 알려주세요." /></label><label className="wide"><span>연락 방법 <small>게시글에 공개됩니다</small></span><input value={form.contact} onChange={(event) => setForm({ ...form, contact: event.target.value })} placeholder="공개용 이메일·Instagram ID·오픈채팅 링크" /></label><label className="honeypot"><span>웹사이트</span><input value={form.website || ""} onChange={(event) => setForm({ ...form, website: event.target.value })} tabIndex={-1} autoComplete="off" /></label></div><footer><span>{storage === "shared" ? "등록 후 모든 사용자에게 공개됩니다." : "현재는 이 브라우저에만 저장되는 체험 모드입니다."}</span><button disabled={saving} onClick={() => void savePost()}>{saving ? "저장 중" : "모집글 등록"} <ArrowRight /></button></footer></div></div>}
  </main>;
}
