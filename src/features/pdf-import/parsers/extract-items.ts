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
  const lines = text.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const phone = text.match(/01[016789][- .]?\d{3,4}[- .]?\d{4}/)?.[0];
  const url = text.match(/https?:\/\/[^\s)]+/)?.[0];
  const yearLines = lines.filter((line) => /(?:19|20)\d{2}/.test(line)).slice(0, 8);
  const intro = lines.find((line) => line.length > 80 && line.length < 450);
  const name = lines.find((line) => line.length >= 2 && line.length <= 24 && !/profile|portfolio|프로필|포트폴리오/i.test(line));

  const items: ExtractedItem[] = [];
  if (name) items.push(makeItem("artist_name", "활동명", name, 0.72));
  if (intro) items.push(makeItem("introduction", "소개문", intro, 0.68));
  yearLines.forEach((line) => items.push(makeItem("career", "주요 경력", line, 0.76)));
  if (email || phone) items.push(makeItem("contact", "연락처", [phone, email].filter(Boolean).join(" · "), 0.91));
  if (url) items.push(makeItem("social_link", "웹/SNS", url, 0.88));
  return items.length ? items : [makeItem("introduction", "PDF 원문", text.slice(0, 600), 0.45)];
}

