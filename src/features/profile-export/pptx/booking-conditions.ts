interface BookingConditionInput {
  performanceDuration?: unknown;
  castSize?: unknown;
  technicalRequirements?: unknown;
}

function bookingInput(value: unknown): BookingConditionInput {
  return typeof value === "object" && value ? value as BookingConditionInput : {};
}

function clean(value: unknown) {
  return String(value || "").replace(/[\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function shorten(value: string, max: number) {
  if (value.length <= max) return value;
  const words = value.split(" ");
  let result = "";
  for (const word of words) {
    const next = result ? `${result} ${word}` : word;
    if (next.length > max) break;
    result = next;
  }
  return result || "";
}

export function normalizePerformanceDuration(value: unknown) {
  const text = clean(value).replace(/x/gi, "×");
  if (!text || /리허설|준비|운영|근무|활동\s*기간/.test(text)) return "";
  const matches = text.match(/\d{1,3}\s*분(?:\s*×\s*\d{1,2}\s*회)?|\d{1,2}(?:\.\d+)?\s*시간(?:\s*\d{1,3}\s*분)?/g) || [];
  const values = [...new Set(matches.map((item) => item.replace(/\s*(분|시간|회)\s*/g, "$1").replace(/\s*×\s*/g, "×")))]
    .filter((item) => Number(item.match(/\d+/)?.[0] || 0) > 0);
  return values.slice(0, 2).join(" / ");
}

export function normalizeCastSize(value: unknown) {
  const text = clean(value);
  if (!text || /관객|좌석|모집|지원\s*인원|수상\s*인원|신청/.test(text)) return "";
  const matches = text.match(/(?:(?:총|출연|연주자|배우|성악가|무용수|댄서|스태프|아티스트|멤버)\s*)?\d{1,2}\s*(?:명|인조|인\s*구성|인)(?![가-힣])/g) || [];
  const values = [...new Set(matches.map((item) => item.replace(/\s+/g, " ").trim()))]
    .filter((item) => Number(item.match(/\d+/)?.[0] || 0) > 0 && Number(item.match(/\d+/)?.[0] || 0) <= 99);
  return values.slice(0, 2).join(" + ");
}

export function normalizeTechnicalRequirements(values: unknown) {
  const list = Array.isArray(values) ? values : clean(values).split(/\s*[·,\n]\s*/);
  const equipment = /마이크|mic|DI|모니터|스피커|PA|음향|조명|프로젝터|빔|스크린|전력|전기|무대|피아노|드럼|앰프|백라인|악기|반입|세팅/i;
  return [...new Set(list.map(clean).filter((item) => item && equipment.test(item)).map((item) => shorten(item, 28)).filter(Boolean))].slice(0, 3);
}

export function normalizedBookingConditions(value: unknown) {
  const profile = bookingInput(value);
  return {
    performanceDuration: normalizePerformanceDuration(profile.performanceDuration),
    castSize: normalizeCastSize(profile.castSize),
    technicalRequirements: normalizeTechnicalRequirements(profile.technicalRequirements),
  };
}

export function hasConfirmedBookingConditions(profile: unknown) {
  const normalized = normalizedBookingConditions(profile);
  return Boolean(normalized.performanceDuration || normalized.castSize || normalized.technicalRequirements.length);
}

export function bookingConditionBullets(profile: unknown) {
  const normalized = normalizedBookingConditions(profile);
  if (!hasConfirmedBookingConditions(normalized)) return [];
  return [
    normalized.performanceDuration ? `공연 시간 · ${normalized.performanceDuration}` : "공연 시간 · 프로그램 구성에 따라 협의",
    normalized.castSize ? `출연 인원 · ${normalized.castSize}` : "출연 인원 · 프로그램 구성에 따라 협의",
    normalized.technicalRequirements.length ? `기술·장비 · ${normalized.technicalRequirements.slice(0, 2).join(" · ")}` : "기술·장비 · 행사 환경에 따라 협의",
  ];
}
