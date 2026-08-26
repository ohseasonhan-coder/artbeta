export interface DecisionHookFact {
  date?: string;
  title?: string;
  organization?: string;
  category?: "career" | "performance" | "award" | "media";
}

export interface DecisionHookProfile {
  purpose?: unknown;
  primaryField?: unknown;
  secondaryField?: unknown;
  region?: unknown;
  performanceDuration?: unknown;
  castSize?: unknown;
  technicalRequirements?: unknown;
  tagline?: unknown;
  strengths?: unknown;
  generatedStrengths?: unknown;
  configurations?: string[];
  repertoire?: string[];
}

function text(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compact(value: string, max: number) {
  const normalized = text(value);
  if (normalized.length <= max) return normalized;
  const words = normalized.split(" ");
  let result = "";
  for (const word of words) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > max - 1) break;
    result = next;
  }
  return `${(result || Array.from(normalized).slice(0, max - 1).join("")).replace(/[.,·;:!?-]+$/, "").trim()}…`;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function factPriority(fact: DecisionHookFact, purpose: string) {
  const weights = /공공|기관/.test(purpose)
    ? { award: 0, performance: 1, career: 2, media: 3 }
    : /기업|브랜드/.test(purpose)
      ? { media: 0, performance: 1, award: 2, career: 3 }
      : /축제|페스티벌|공연장|극장/.test(purpose)
        ? { performance: 0, award: 1, media: 2, career: 3 }
        : { performance: 0, award: 1, career: 2, media: 3 };
  const year = Number(text(fact.date).match(/(?:19|20)\d{2}/)?.[0] || 0);
  return (weights[fact.category || "career"] ?? 3) * 10_000 - year;
}

export function buildDecisionHookTitle(profile: DecisionHookProfile) {
  const purpose = text(profile.purpose);
  if (/공공|기관/.test(purpose)) return "공공 무대 검토에 필요한 근거와 조건";
  if (/기업|브랜드/.test(purpose)) return "행사 목적에 맞춰 선택하는 무대 구성";
  if (/축제|페스티벌/.test(purpose)) return "축제 현장에 맞춘 무대와 운영 조건";
  if (/공연장|극장/.test(purpose)) return "공연장 검토를 위한 프로그램과 활동 근거";
  if (/해외|글로벌/.test(purpose)) return "해외 무대 검토를 위한 활동 근거와 구성";
  return "섭외 판단에 필요한 가치와 근거";
}

export function buildDecisionHookBullets(profile: DecisionHookProfile, facts: DecisionHookFact[]) {
  const purpose = text(profile.purpose) || "공연·행사 제안";
  const field = [text(profile.primaryField), text(profile.secondaryField)].filter(Boolean).join(" · ") || "문화예술";
  const fit = compact(`제안 적합성 · ${purpose} · ${field}`, 48);
  const strongestFact = [...facts].filter((fact) => text(fact.title)).sort((a, b) => factPriority(a, purpose) - factPriority(b, purpose))[0];
  const proof = strongestFact
    ? compact(`공식 근거 · ${[text(strongestFact.date), text(strongestFact.title), text(strongestFact.organization)].filter(Boolean).join(" · ")}`, 48)
    : "";
  const conditions = [text(profile.performanceDuration), text(profile.castSize), ...stringList(profile.technicalRequirements)].filter(Boolean);
  const configurations = (profile.configurations ?? []).map(text).filter(Boolean);
  const repertoire = (profile.repertoire ?? []).map(text).filter(Boolean);
  const choice = conditions.length
    ? compact(`운영 조건 · ${conditions.slice(0, 3).join(" · ")}`, 48)
    : configurations.length
      ? compact(`선택 구성 · ${configurations.slice(0, 2).join(" · ")}`, 48)
      : repertoire.length
        ? compact(`선택 프로그램 · ${repertoire.slice(0, 2).join(" · ")}`, 48)
        : "";
  const strengths = [...stringList(profile.generatedStrengths), ...stringList(profile.strengths), text(profile.tagline)].filter(Boolean);
  const fallback = strengths[0] ? compact(`제안 포인트 · ${strengths[0]}`, 48) : text(profile.region) ? compact(`활동 기반 · ${text(profile.region)} · ${field}`, 48) : "";
  return [...new Set([fit, proof, choice || fallback].filter(Boolean))].slice(0, 3);
}

export function hasStrongDecisionHooks(title: string, bullets: string[], hasFacts: boolean) {
  const labels = bullets.map((bullet) => bullet.split("·")[0].trim());
  const hasFit = labels.includes("제안 적합성");
  const hasProof = !hasFacts || labels.includes("공식 근거");
  const hasChoice = labels.some((label) => ["운영 조건", "선택 구성", "선택 프로그램", "제안 포인트", "활동 기반"].includes(label));
  const isBuyerTitle = /검토|선택|섭외|무대|근거|조건|프로그램/.test(title) && !/^(주요 활동|아티스트 소개|대표 사진|프로필)$/i.test(title.trim());
  return isBuyerTitle && hasFit && hasProof && hasChoice && bullets.length === 3;
}
