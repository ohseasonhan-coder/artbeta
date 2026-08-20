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

export function formatCareerFact(fact: DeckFact, compact = false) {
  const datePattern = /(?:19|20)\d{2}(?:[.\-/년월일\s]\d{1,2})*/g;
  const title = fact.title
    .replace(datePattern, "")
    .replace(/^(주요\s*)?(경력|공연|활동|수상|선정|방송|언론)\s*[:·|｜-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[-–—,.:·\s]+|[-–—,.:·\s]+$/g, "")
    .trim();
  const organization = fact.organization.replace(/\s+/g, " ").trim();
  const showOrganization = organization && !title.replace(/\s/g, "").includes(organization.replace(/\s/g, ""));
  return {
    date: fact.date.replace(/\s+/g, " ").trim() || "—",
    title: shortenAtWord(title || fact.title.trim(), compact ? 28 : 40),
    meta: shortenAtWord([showOrganization ? organization : "", fact.pageNumber ? `원문 ${fact.pageNumber}p` : ""].filter(Boolean).join(" · "), compact ? 28 : 48),
  };
}

export function formatCustomerValueEvidence(fact: DeckFact) {
  const formatted = formatCareerFact(fact, true);
  const value = fact.category === "award"
    ? "공식 성과가 선택의 신뢰를 높입니다"
    : fact.category === "performance"
      ? "검증된 무대 경험이 현장 운영의 안정성을 높입니다"
      : fact.category === "media"
        ? "대외 기록이 인지도와 전달력을 뒷받침합니다"
        : "지속적인 활동이 협업 신뢰를 뒷받침합니다";
  return `근거 · ${[formatted.date !== "—" ? formatted.date : "", formatted.title].filter(Boolean).join(" ")} — ${value}`;
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
