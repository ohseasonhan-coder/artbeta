export type HomeSectionKey = "identity" | "upload" | "link" | "aiStatus" | "trust";

export interface SiteConfig {
  version: number;
  brand: { name: string; mark: string; tagline: string };
  navigation: { studio: string; team: string; admin: string; newProject: string };
  theme: {
    primary: string;
    accent: string;
    ink: string;
    paper: string;
    surface: string;
    radius: number;
    contentWidth: number;
    fontScale: number;
    headerStyle: "solid" | "glass";
  };
  home: {
    eyebrow: string;
    title: string;
    accentTitle: string;
    description: string;
    uploadTitle: string;
    uploadDescription: string;
    noMaterialLabel: string;
    trustItems: string[];
    sections: Array<{ key: HomeSectionKey; enabled: boolean }>;
  };
  team: {
    eyebrow: string;
    title: string;
    description: string;
    createLabel: string;
    searchPlaceholder: string;
    showDemoPosts: boolean;
  };
  updatedAt: string;
}

export const defaultSiteConfig: SiteConfig = {
  version: 1,
  brand: { name: "ARTFOLIO", mark: "A", tagline: "Artist Profile & Collaboration Platform" },
  navigation: { studio: "프로필 만들기", team: "팀원 찾기", admin: "사이트 관리", newProject: "새로 시작" },
  theme: { primary: "#1f6049", accent: "#d9ff43", ink: "#10251b", paper: "#f7f8f5", surface: "#ffffff", radius: 16, contentWidth: 1180, fontScale: 100, headerStyle: "glass" },
  home: {
    eyebrow: "ARTIST PROFILE STUDIO",
    title: "자료에서 시작하는",
    accentTitle: "전문 아티스트 프로필",
    description: "보유한 PDF·PPTX·사진을 분석해 소개, 경력, 수상, 공연 기록과 적합한 이미지를 자동 선별하고 편집 가능한 제안용 PPT로 완성합니다.",
    uploadTitle: "프로필 자료 통합 업로드",
    uploadDescription: "파일을 선택하면 바로 분석을 시작합니다 · PDF 30MB, PPTX 40MB, 사진 각 10MB",
    noMaterialLabel: "자료 없이 기본 정보로 시작하기",
    trustItems: ["원본 근거 기반 분석", "편집 가능한 PPTX", "초안 자동 저장"],
    sections: [
      { key: "identity", enabled: true }, { key: "upload", enabled: true }, { key: "link", enabled: true },
      { key: "aiStatus", enabled: true }, { key: "trust", enabled: true },
    ],
  },
  team: {
    eyebrow: "PROFILE-BASED MATCHING",
    title: "프로필로 확인하고\n함께할 예술인을 찾으세요",
    description: "자유게시판의 긴 글 대신 분야·지역·역할·일정만 비교합니다. 완성한 프로필이 모집글에 자동으로 연결됩니다.",
    createLabel: "모집글 작성",
    searchPlaceholder: "역할·분야·활동명만 검색",
    showDemoPosts: true,
  },
  updatedAt: "",
};

export function mergeSiteConfig(value?: Partial<SiteConfig> | null): SiteConfig {
  if (!value) return defaultSiteConfig;
  return {
    ...defaultSiteConfig, ...value,
    brand: { ...defaultSiteConfig.brand, ...value.brand },
    navigation: { ...defaultSiteConfig.navigation, ...value.navigation },
    theme: { ...defaultSiteConfig.theme, ...value.theme },
    home: { ...defaultSiteConfig.home, ...value.home, sections: value.home?.sections?.length ? value.home.sections : defaultSiteConfig.home.sections, trustItems: value.home?.trustItems?.length ? value.home.trustItems : defaultSiteConfig.home.trustItems },
    team: { ...defaultSiteConfig.team, ...value.team },
  };
}
