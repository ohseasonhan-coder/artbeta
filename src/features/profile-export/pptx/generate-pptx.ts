import { ProfileData } from "@/types/profile";
import { getTemplate } from "@/features/design-templates/registry/templates";

const hex = (value: string) => value.replace("#", "");

export async function downloadPptx(profile: ProfileData) {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const template = getTemplate(profile.templateKey);
  const p = template.palette;
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Artfolio Studio";
  pptx.subject = `${profile.artistName} 예술인 프로필`;
  pptx.title = `${profile.artistName || "예술인"} Profile`;
  pptx.company = "Artfolio";
  pptx.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
  };

  const addFooter = (slide: ReturnType<typeof pptx.addSlide>, index: number) => {
    slide.addText(String(index).padStart(2, "0"), { x: 12.1, y: 7.05, w: 0.55, h: 0.18, fontSize: 7, color: hex(p.muted), margin: 0, align: "right" });
  };

  const cover = pptx.addSlide();
  cover.background = { color: hex(p.background) };
  cover.addShape(pptx.ShapeType.rect, { x: 0.55, y: 0.55, w: 0.1, h: 6.4, fill: { color: hex(p.accent) }, line: { transparency: 100 } });
  cover.addText("ARTIST PROFILE", { x: 1.05, y: 0.8, w: 4, h: 0.3, fontSize: 10, bold: true, charSpacing: 3, color: hex(p.accent), margin: 0 });
  cover.addText(profile.artistName || "ARTIST NAME", { x: 1.02, y: 2.25, w: 10.8, h: 1.05, fontSize: 42, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
  cover.addText(profile.tagline || `${profile.primaryField || "공연예술"}로 만나는 새로운 장면`, { x: 1.05, y: 3.5, w: 8.2, h: 0.75, fontSize: 18, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
  cover.addText(`${profile.primaryField || "PERFORMING ARTS"} · ${new Date().getFullYear()}`, { x: 1.05, y: 6.55, w: 5.5, h: 0.25, fontSize: 9, color: hex(p.muted), margin: 0 });

  const intro = pptx.addSlide();
  intro.background = { color: hex(p.surface) };
  intro.addText("01", { x: 0.7, y: 0.55, w: 0.8, h: 0.5, fontSize: 24, color: hex(p.accent), bold: true, margin: 0 });
  intro.addText("ABOUT", { x: 1.65, y: 0.65, w: 2.6, h: 0.3, fontSize: 10, charSpacing: 3, color: hex(p.muted), bold: true, margin: 0 });
  intro.addText(profile.tagline || "예술로 오래 기억될 장면을 만듭니다", { x: 1.65, y: 1.55, w: 9.8, h: 1.2, fontSize: 30, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
  intro.addText(profile.introduction || "프로필 소개문을 생성하면 이곳에 예술인의 이야기가 표시됩니다.", { x: 1.68, y: 3.15, w: 8.7, h: 1.8, fontSize: 15, breakLine: false, color: hex(p.muted), margin: 0, fit: "shrink", paraSpaceAfter: 10 });
  addFooter(intro, 2);

  const strengths = pptx.addSlide();
  strengths.background = { color: hex(p.background) };
  strengths.addText("CORE STRENGTHS", { x: 0.85, y: 0.72, w: 4.4, h: 0.35, fontSize: 11, color: hex(p.accent), bold: true, charSpacing: 2.5, margin: 0 });
  strengths.addText("무대를 완성하는 세 가지 힘", { x: 0.85, y: 1.32, w: 8.6, h: 0.65, fontSize: 27, bold: true, color: hex(p.text), margin: 0 });
  const strengthItems = profile.generatedStrengths.length ? profile.generatedStrengths : ["분야의 전문성", "유연한 프로그램 구성", "관객과의 자연스러운 호흡"];
  strengthItems.slice(0, 3).forEach((item, index) => {
    const x = 0.85 + index * 4.05;
    strengths.addShape(pptx.ShapeType.roundRect, { x, y: 2.55, w: 3.55, h: 2.75, rectRadius: 0.08, fill: { color: hex(p.surface) }, line: { color: hex(p.surface) } });
    strengths.addText(`0${index + 1}`, { x: x + 0.35, y: 2.9, w: 0.6, h: 0.4, fontSize: 13, bold: true, color: hex(p.accent), margin: 0 });
    strengths.addText(item, { x: x + 0.35, y: 3.7, w: 2.85, h: 0.9, fontSize: 18, bold: true, color: hex(p.text), margin: 0, fit: "shrink", valign: "middle" });
  });
  addFooter(strengths, 3);

  const career = pptx.addSlide();
  career.background = { color: hex(p.surface) };
  career.addText("SELECTED WORK", { x: 0.85, y: 0.7, w: 4.2, h: 0.35, fontSize: 11, color: hex(p.accent), bold: true, charSpacing: 2.5, margin: 0 });
  career.addText("주요 활동", { x: 0.85, y: 1.3, w: 4.2, h: 0.65, fontSize: 28, bold: true, color: hex(p.text), margin: 0 });
  const careers = profile.careers.filter((item) => item.title.trim()).slice(0, 7);
  (careers.length ? careers : [{ id: "empty", year: "—", title: "주요 경력을 입력해 주세요", organization: "" }]).forEach((item, index) => {
    const y = 2.35 + index * 0.58;
    career.addText(item.year || "—", { x: 0.9, y, w: 1.1, h: 0.25, fontSize: 10, bold: true, color: hex(p.accent), margin: 0 });
    career.addText(item.title, { x: 2.25, y: y - 0.03, w: 6.6, h: 0.3, fontSize: 13, bold: true, color: hex(p.text), margin: 0, fit: "shrink" });
    career.addText(item.organization, { x: 9.05, y, w: 2.8, h: 0.25, fontSize: 9, color: hex(p.muted), margin: 0, align: "right", fit: "shrink" });
    career.addShape(pptx.ShapeType.line, { x: 2.25, y: y + 0.37, w: 9.6, h: 0, line: { color: hex(p.muted), transparency: 75, width: 0.6 } });
  });
  addFooter(career, 4);

  const contact = pptx.addSlide();
  contact.background = { color: hex(p.background) };
  contact.addText("LET'S CREATE\nA NEW SCENE.", { x: 0.9, y: 1.2, w: 8.7, h: 2.2, fontSize: 39, bold: true, color: hex(p.text), margin: 0, breakLine: false, fit: "shrink" });
  contact.addText(profile.artistName || "ARTIST", { x: 0.95, y: 4.65, w: 4, h: 0.4, fontSize: 15, bold: true, color: hex(p.accent), margin: 0 });
  contact.addText([profile.contact, profile.videoUrl, profile.region].filter(Boolean).join("\n") || "연락 정보를 입력해 주세요", { x: 0.95, y: 5.25, w: 6.5, h: 0.9, fontSize: 11, color: hex(p.muted), margin: 0, breakLine: false, fit: "shrink" });
  addFooter(contact, 5);

  await pptx.writeFile({ fileName: `${profile.artistName || "artist"}_profile.pptx` });
}
