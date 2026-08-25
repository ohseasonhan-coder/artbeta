import { ExtractedItem } from "@/types/profile";

const makeItem = (type: ExtractedItem["type"], label: string, value: string, confidence: number): ExtractedItem => ({
  id: `${type}-${Math.random().toString(36).slice(2)}`,
  type,
  label,
  value,
  confidence,
  status: confidence < 0.7 ? "needs_review" : "approved",
});

export function inferItemsFromText(text: string): ExtractedItem[] {
  const lines = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?=(?:19|20)\d{2}[.년\-/])/g))
    .map((line) => line.replace(/\s+/g, " ").replace(/^[•·▪■□▶▷◆◇-]\s*/, "").trim())
    .filter((line) => line.length > 1);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = text.match(/01[016789][- .]?\d{3,4}[- .]?\d{4}/)?.[0];
  const urls = [...new Set(text.match(/https?:\/\/[^\s)]+/g) ?? [])];
  const datedLines = [...new Set(lines.filter((line) => /(?:19|20)\d{2}(?:[.년\-/]|\s)/.test(line) && line.length < 360))];
  const intro = lines.find((line) => line.length > 60 && line.length < 600 && !/(?:19|20)\d{2}/.test(line));
  const name = lines.find((line) => line.length >= 2 && line.length <= 24 && !/profile|portfolio|프로필|포트폴리오|history|career|연혁|경력/i.test(line));
  const durationLine = lines.find((line) => /공연\s*(시간|길이)|러닝\s*타임|running\s*time|소요\s*시간|(?:^|\s)\d{1,3}\s*분(?:\s|$|×|x)/i.test(line) && !/리허설|준비|운영\s*시간/i.test(line));
  const castLine = lines.find((line) => /출연\s*(인원|진)|구성\s*인원|연주자\s*\d+\s*명|총\s*\d+\s*명|\d+\s*인조/i.test(line) && !/관객|모집|수상|지원/i.test(line));
  const technicalLines = [...new Set(lines.filter((line) => /테크니컬|technical|음향|PA\b|마이크|DI\s*(box|박스)?|모니터\s*스피커|조명|프로젝터|스크린|전력|전기\s*용량|무대\s*(규격|크기)|백라인|backline/i.test(line) && line.length <= 280))].slice(0, 4);

  const items: ExtractedItem[] = [];
  if (name) items.push(makeItem("artist_name", "활동명", name, 0.72));
  if (intro) items.push(makeItem("introduction", "소개문", intro, 0.68));
  datedLines.forEach((line) => {
    if (/수상|대상|최우수|우수상|금상|은상|동상|선정|표창|award/i.test(line)) {
      items.push(makeItem("award", "수상·선정", line, 0.76));
    } else if (/공연|콘서트|축제|페스티벌|무대|초청|투어|연주|발표회|전시|퍼포먼스/i.test(line)) {
      items.push(makeItem("performance", "공연·활동", line, 0.76));
    } else if (/방송|인터뷰|기사|신문|라디오|TV|출연|보도/i.test(line)) {
      items.push(makeItem("media", "방송·언론", line, 0.74));
    } else {
      items.push(makeItem("career", "연혁·경력", line, 0.74));
    }
  });
  if (email || phone) items.push(makeItem("contact", "연락처", [phone, email].filter(Boolean).join(" · "), 0.91));
  urls.forEach((url) => items.push(makeItem("social_link", "웹/SNS", url, 0.88)));
  if (durationLine) items.push(makeItem("performance_duration", "공연 시간", durationLine, 0.78));
  if (castLine) items.push(makeItem("cast_size", "출연 인원", castLine, 0.78));
  technicalLines.forEach((line) => items.push(makeItem("technical_requirement", "기술·장비 조건", line, 0.76)));
  return items.length ? items : [makeItem("introduction", "PDF 원문", text.slice(0, 1200), 0.45)];
}
