import { ExtractedItem, ProfileData } from "@/types/profile";

export type DeckFactCategory = "career" | "performance" | "award" | "media";

export interface DeckFact {
  id: string;
  date: string;
  title: string;
  organization: string;
  category: DeckFactCategory;
  categoryLabel: string;
  pageNumber?: number;
  source: "profile" | "pdf" | "web";
  sourceName?: string;
  sourceUrl?: string;
  verificationTier?: "primary" | "platform" | "reference";
}

function shortenAtWord(value: string, max: number) {
  if (value.length <= max) return value;
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  let result = "";
  for (const word of words) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > max - 1) break;
    result = next;
  }
  return result ? `${result.replace(/[.,·;:!?-]+$/, "").trim()}…` : words[0];
}

function stripInternalSourceMarkers(value: string) {
  return value
    .replace(/(?:^|[·|｜,;/\s])(?:원문\s*)?\d+\s*(?:p|페이지|슬라이드)(?=$|[·|｜,;/\s])/gi, " ")
    .replace(/\s*[·|｜]\s*[·|｜]\s*/g, " · ")
    .replace(/^\s*[·|｜,;/]+|[·|｜,;/]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatCareerFact(fact: DeckFact, compact = false) {
  const datePattern = /(?:19|20)\d{2}(?:[.\-/년월일\s]\d{1,2})*/g;
  const title = stripInternalSourceMarkers(fact.title)
    .replace(datePattern, "")
    .replace(/^(주요\s*)?(경력|공연|활동|수상|선정|방송|언론)\s*[:·|｜-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[-–—,.:·\s]+|[-–—,.:·\s]+$/g, "")
    .trim();
  const organization = stripInternalSourceMarkers(fact.organization);
  const showOrganization = organization && !title.replace(/\s/g, "").includes(organization.replace(/\s/g, ""));
  return {
    date: stripInternalSourceMarkers(fact.date) || "—",
    title: shortenAtWord(title || fact.title.trim(), compact ? 28 : 40),
    meta: shortenAtWord(showOrganization ? organization : "", compact ? 28 : 48),
  };
}

export function formatCustomerValueEvidence(fact: DeckFact, purpose = "") {
  const formatted = formatCareerFact(fact, true);
  const isFestival = /축제|페스티벌/.test(purpose);
  const isCorporate = /기업|브랜드/.test(purpose);
  const isVenue = /공연장|극장/.test(purpose);
  const isPublic = /공공|기관/.test(purpose);
  const value = fact.category === "award"
    ? isPublic ? "공식 선정 이력이 사업 신뢰도를 뒷받침합니다" : "공식 성과가 섭외 판단의 신뢰를 높입니다"
    : fact.category === "performance"
      ? isFestival ? "실제 무대 경험이 현장 대응력을 보여줍니다" : isVenue ? "공연 이력이 프로그램 실행 가능성을 보여줍니다" : "실제 무대 경험이 안정적인 운영을 뒷받침합니다"
      : fact.category === "media"
        ? isCorporate ? "대외 노출 이력이 행사 전달력을 뒷받침합니다" : "대외 기록이 인지도와 전달력을 보여줍니다"
        : "지속적인 활동 이력이 협업 신뢰를 뒷받침합니다";
  return `근거 · ${[formatted.date !== "—" ? formatted.date : "", formatted.title].filter(Boolean).join(" ")} — ${value}`;
}

function purposeCategoryScore(category: DeckFactCategory, purpose: string) {
  if (/공공|기관/.test(purpose)) return { award: 36, performance: 28, career: 22, media: 16 }[category];
  if (/기업|브랜드/.test(purpose)) return { media: 34, performance: 32, career: 24, award: 20 }[category];
  if (/축제|페스티벌/.test(purpose)) return { performance: 38, media: 25, award: 22, career: 20 }[category];
  if (/공연장|극장/.test(purpose)) return { performance: 40, award: 26, career: 24, media: 14 }[category];
  if (/해외|글로벌/.test(purpose)) return { performance: 36, award: 30, media: 24, career: 20 }[category];
  return { award: 32, performance: 30, career: 22, media: 18 }[category];
}

export function rankDeckFactIndexes(facts: DeckFact[], purpose: string, limit: number) {
  const currentYear = new Date().getFullYear();
  const scored = facts.map((fact, index) => {
    const year = Number(fact.date.match(/(?:19|20)\d{2}/)?.[0] || 0);
    const recency = year ? Math.max(0, 12 - Math.min(12, currentYear - year)) : 2;
    const authorityText = `${fact.title} ${fact.organization}`;
    const authority = /문화체육관광부|예술위원회|문화재단|시청|도청|구청|국립|시립|세종문화회관|예술의전당|방송|신문|festival|페스티벌/i.test(authorityText) ? 14 : 4;
    const verification = fact.verificationTier === "primary" ? 16 : fact.verificationTier === "platform" ? 11 : fact.source === "profile" ? 9 : fact.source === "pdf" ? 8 : 4;
    const completeness = [fact.date, fact.title, fact.organization].filter((value) => value.trim()).length * 2;
    return { index, category: fact.category, score: purposeCategoryScore(fact.category, purpose) + recency + authority + verification + completeness };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: number[] = [];
  const categoryCounts = new Map<DeckFactCategory, number>();
  while (selected.length < Math.min(limit, facts.length)) {
    const next = scored.find((candidate) => !selected.includes(candidate.index) && (categoryCounts.get(candidate.category) || 0) < Math.max(2, Math.ceil(limit / 2)))
      || scored.find((candidate) => !selected.includes(candidate.index));
    if (!next) break;
    selected.push(next.index);
    categoryCounts.set(next.category, (categoryCounts.get(next.category) || 0) + 1);
  }
  return selected;
}

const categoryLabels: Record<DeckFactCategory, string> = {
  career: "주요 경력",
  performance: "공연·활동",
  award: "수상·선정",
  media: "방송·언론",
};

function inferCategory(value: string): DeckFactCategory {
  if (/수상|대상|최우수|우수상|금상|은상|동상|선정|표창|award/i.test(value)) return "award";
  if (/방송|언론|인터뷰|기사|보도|출연|media|tv|radio/i.test(value)) return "media";
  if (/공연|콘서트|축제|페스티벌|전시|무대|초청|performance/i.test(value)) return "performance";
  return "career";
}

function factKey(date: string, title: string) {
  const normalizedDate = date.toLowerCase().replace(/[^0-9]/g, "");
  const normalizedTitle = title.toLowerCase().replace(/(?:19|20)\d{2}(?:[.\-/년월일\s]\d{1,2})*/g, "").replace(/[^0-9a-z가-힣]/g, "").slice(0, 90);
  return `${normalizedDate}|${normalizedTitle}`;
}

function extractedToFact(item: ExtractedItem): DeckFact | null {
  if (!["career", "performance", "award", "media"].includes(item.type) || item.status === "excluded" || !item.value.trim()) return null;
  const category = item.type as DeckFactCategory;
  const date = item.value.match(/(?:19|20)\d{2}(?:[.\-/년]\s*\d{1,2})?(?:[.\-/월]\s*\d{1,2})?/)?.[0] ?? "";
  const parts = item.value.replace(date, "").split(/\s*[·|｜]\s*/).map((value) => value.trim()).filter(Boolean);
  const title = (parts.shift() || item.value.replace(date, "")).replace(/^[-–—,.:\s]+/, "").trim();
  const organization = parts.join(" · ");
  return {
    id: item.id,
    date,
    title,
    organization,
    category,
    categoryLabel: categoryLabels[category],
    pageNumber: item.pageNumber,
    source: item.sourceUrl ? "web" : "pdf",
    sourceName: item.sourceName,
    sourceUrl: item.sourceUrl,
    verificationTier: item.verificationTier,
  };
}

export function buildDeckFacts(profile: ProfileData): DeckFact[] {
  const facts: DeckFact[] = [];
  const keys = new Set<string>();
  const excludedKeys = new Set(profile.extractedItems.filter((item) => item.status === "excluded").map((item) => {
    const date = item.value.match(/(?:19|20)\d{2}(?:[.\-/년]\s*\d{1,2})?(?:[.\-/월]\s*\d{1,2})?/)?.[0] ?? "";
    const title = item.value.replace(date, "").split(/\s*[·|｜]\s*/)[0].replace(/^[-–—,.:\s]+/, "").trim();
    return factKey(date, title);
  }));
  const add = (fact: DeckFact) => {
    if (!fact.title.trim()) return;
    const key = factKey(fact.date, fact.title);
    if (keys.has(key)) return;
    keys.add(key);
    facts.push(fact);
  };

  profile.careers.forEach((career) => {
    if (!career.title.trim()) return;
    if (excludedKeys.has(factKey(career.year, career.title))) return;
    const category = inferCategory(`${career.title} ${career.organization}`);
    add({
      id: career.id,
      date: career.year,
      title: career.title,
      organization: career.organization,
      category,
      categoryLabel: categoryLabels[category],
      source: career.sourceUrl ? "web" : "profile",
      sourceName: career.sourceName,
      sourceUrl: career.sourceUrl,
      verificationTier: career.verificationTier,
    });
  });

  profile.extractedItems.forEach((item) => {
    const fact = extractedToFact(item);
    if (fact) add(fact);
  });

  return facts;
}
