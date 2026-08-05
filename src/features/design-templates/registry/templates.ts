export interface DesignTemplate {
  key: string;
  name: string;
  description: string;
  category: string;
  recommendedFor: string[];
  palette: { background: string; surface: string; primary: string; accent: string; text: string; muted: string };
}

export const designTemplates: DesignTemplate[] = [
  {
    key: "modern_navy_01",
    name: "모던 네이비",
    description: "신뢰감 있는 구성과 선명한 타이포그래피",
    category: "Modern",
    recommendedFor: ["기업행사", "공공기관", "클래식"],
    palette: { background: "#091426", surface: "#14223a", primary: "#f5f1e8", accent: "#d5a44f", text: "#f7f8fb", muted: "#a6b0c2" },
  },
  {
    key: "warm_beige_01",
    name: "웜 베이지",
    description: "따뜻하고 편안한 분위기의 에디토리얼 디자인",
    category: "Warm",
    recommendedFor: ["가족행사", "어쿠스틱", "교육"],
    palette: { background: "#eee5d7", surface: "#f8f3eb", primary: "#352f2a", accent: "#b65f3b", text: "#2b2825", muted: "#786f66" },
  },
  {
    key: "festival_dynamic_01",
    name: "페스티벌 다이내믹",
    description: "무대의 에너지를 살린 대담한 컬러와 레이아웃",
    category: "Dynamic",
    recommendedFor: ["축제", "밴드", "거리공연"],
    palette: { background: "#161616", surface: "#242424", primary: "#f2ff5a", accent: "#ff5d42", text: "#ffffff", muted: "#b8b8b8" },
  },
  {
    key: "korean_traditional_01",
    name: "한국의 결",
    description: "여백과 전통색을 현대적으로 재해석한 디자인",
    category: "Heritage",
    recommendedFor: ["국악", "전통예술", "해외공연"],
    palette: { background: "#f3efe5", surface: "#e5ddcc", primary: "#172b28", accent: "#a43d32", text: "#172b28", muted: "#6d716b" },
  },
];

export const getTemplate = (key: string) => designTemplates.find((item) => item.key === key) ?? designTemplates[0];

