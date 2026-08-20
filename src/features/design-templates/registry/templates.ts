export type TemplateComposition = "institutional" | "human" | "dynamic" | "heritage" | "gallery" | "spotlight";

export interface DesignTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  recommendedFor: string[];
  recommendedFields: string[];
  recommendedPurposes: string[];
  composition: TemplateComposition;
  typography: { heading: string; body: string };
  coverImageSide: "left" | "right";
  palette: { background: string; surface: string; primary: string; accent: string; text: string; muted: string };
}

export const designTemplates: DesignTemplate[] = [
  {
    key: "modern_navy_01", name: "시빅 에디토리얼", category: "Institutional", composition: "institutional", coverImageSide: "right",
    description: "공공·기업 담당자가 신뢰를 빠르게 판단하는 정돈된 제안서",
    recommendedFor: ["공공기관", "기업행사", "클래식"], recommendedFields: ["연주", "진행·MC", "복합예술"], recommendedPurposes: ["공공기관 제안", "기업 행사 제안"],
    typography: { heading: "Aptos Display", body: "Aptos" },
    palette: { background: "#091426", surface: "#14223a", primary: "#f5f1e8", accent: "#d5a44f", text: "#f7f8fb", muted: "#a6b0c2" },
  },
  {
    key: "warm_beige_01", name: "휴먼 스토리", category: "Human", composition: "human", coverImageSide: "left",
    description: "교육·가족 행사에서 친밀감과 진정성을 전달하는 에디토리얼",
    recommendedFor: ["가족행사", "어쿠스틱", "교육"], recommendedFields: ["보컬", "연주", "기타"], recommendedPurposes: ["공공기관 제안", "공연장 제출"],
    typography: { heading: "Georgia", body: "Aptos" },
    palette: { background: "#eee5d7", surface: "#f8f3eb", primary: "#352f2a", accent: "#b65f3b", text: "#2b2825", muted: "#786f66" },
  },
  {
    key: "festival_dynamic_01", name: "페스티벌 임팩트", category: "Dynamic", composition: "dynamic", coverImageSide: "right",
    description: "축제·거리 공연의 에너지와 관객 반응을 전면에 내세우는 구성",
    recommendedFor: ["축제", "밴드", "거리공연"], recommendedFields: ["보컬", "퍼포먼스", "마술", "복합예술"], recommendedPurposes: ["축제 섭외", "기업 행사 제안"],
    typography: { heading: "Arial", body: "Aptos" },
    palette: { background: "#161616", surface: "#242424", primary: "#f2ff5a", accent: "#ff5d42", text: "#ffffff", muted: "#b8b8b8" },
  },
  {
    key: "korean_traditional_01", name: "한국의 결", category: "Heritage", composition: "heritage", coverImageSide: "left",
    description: "전통의 품격과 현대적 활용 가능성을 함께 보여주는 여백 중심 구성",
    recommendedFor: ["국악", "전통예술", "해외공연"], recommendedFields: ["국악", "전통예술"], recommendedPurposes: ["해외 공연 제안", "공공기관 제안", "공연장 제출"],
    typography: { heading: "Batang", body: "Malgun Gothic" },
    palette: { background: "#f3efe5", surface: "#e5ddcc", primary: "#172b28", accent: "#a43d32", text: "#172b28", muted: "#6d716b" },
  },
  {
    key: "gallery_white_01", name: "갤러리 모노", category: "Gallery", composition: "gallery", coverImageSide: "right",
    description: "작품과 움직임을 크게 보여주는 미술관형 미니멀 포트폴리오",
    recommendedFor: ["전시", "무용", "창작", "공연장"], recommendedFields: ["무용", "퍼포먼스", "복합예술"], recommendedPurposes: ["공연장 제출", "공공기관 제안"],
    typography: { heading: "Arial", body: "Aptos" },
    palette: { background: "#f4f4f1", surface: "#ffffff", primary: "#111111", accent: "#3d65ff", text: "#111111", muted: "#747474" },
  },
  {
    key: "global_spotlight_01", name: "글로벌 스포트라이트", category: "Spotlight", composition: "spotlight", coverImageSide: "left",
    description: "해외·대형 무대에서 스타성과 확장성을 강조하는 시네마틱 시스템",
    recommendedFor: ["해외공연", "대형무대", "K-퍼포먼스"], recommendedFields: ["보컬", "무용", "퍼포먼스", "마술"], recommendedPurposes: ["해외 공연 제안", "축제 섭외"],
    typography: { heading: "Aptos Display", body: "Aptos" },
    palette: { background: "#07070b", surface: "#15141f", primary: "#f7f4ff", accent: "#a77bff", text: "#ffffff", muted: "#aaa6bb" },
  },
];

export function recommendTemplateKey(profile: { primaryField?: string; purpose?: string; experiences?: string[] }) {
  const signals = [profile.primaryField, profile.purpose, ...(profile.experiences ?? [])].filter(Boolean).map(String);
  return designTemplates.map((template, index) => ({
    template, index,
    score: signals.reduce((score, signal) => score
      + (template.recommendedFields.some((item) => signal.includes(item) || item.includes(signal)) ? 4 : 0)
      + (template.recommendedPurposes.some((item) => signal.includes(item) || item.includes(signal)) ? 5 : 0)
      + (template.recommendedFor.some((item) => signal.includes(item) || item.includes(signal)) ? 2 : 0), 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index)[0].template.key;
}

export const getTemplate = (key: string) => designTemplates.find((item) => item.key === key) ?? designTemplates[0];
