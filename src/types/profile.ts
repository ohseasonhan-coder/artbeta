export type SourceType = "pdf" | "questionnaire" | "unsure";
export type ReviewStatus = "approved" | "edited" | "excluded" | "needs_review";

export interface Career {
  id: string;
  year: string;
  title: string;
  organization: string;
}

export interface ExtractedItem {
  id: string;
  type:
    | "artist_name"
    | "artist_type"
    | "field"
    | "introduction"
    | "tagline"
    | "career"
    | "performance"
    | "award"
    | "media"
    | "member"
    | "contact"
    | "social_link"
    | "equipment"
    | "strength"
    | "region";
  label: string;
  value: string;
  confidence: number;
  status: ReviewStatus;
  pageNumber?: number;
}

export interface PdfPageAsset {
  pageNumber: number;
  previewDataUrl: string;
  text: string;
  textSource: "embedded" | "ocr" | "none";
  confidence: number;
  selected: boolean;
}

export interface ExternalImageAsset {
  id: string;
  dataUrl: string;
  source: "naver" | "google" | "youtube" | "ai";
  sourceUrl?: string;
  title: string;
  relevanceScore: number;
  qualityScore: number;
  disclosure?: string;
  promptBasis?: string;
  watermarkDetected?: boolean;
  usageStatus?: "approved" | "review" | "blocked";
}

export type DeckSlideType = "cover" | "about" | "strengths" | "gallery" | "career" | "contact";
export type DeckLayout = "full_bleed" | "split_left" | "split_right" | "editorial" | "timeline" | "gallery";

export interface DeckSlidePlan {
  type: DeckSlideType;
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  imageRefs: string[];
  imagePurpose: string;
  careerIndexes: number[];
  layout: DeckLayout;
}

export interface DeckPlan {
  narrative: string;
  visualDirection: string;
  slides: DeckSlidePlan[];
}

export interface DeckPlanMeta {
  mode: "ai" | "local";
  provider: string;
  model: string;
  warning?: string;
  errorCode?: string;
  qualityScore?: number;
  coveredFactCount?: number;
  totalFactCount?: number;
}

export interface ProfileData {
  source: SourceType | null;
  artistName: string;
  artistType: "개인" | "단체";
  primaryField: string;
  secondaryField: string;
  region: string;
  members: string;
  contact: string;
  videoUrl: string;
  careers: Career[];
  strengths: string[];
  experiences: string[];
  impressions: string[];
  tone: string;
  purpose: string;
  pageCount: number;
  templateKey: string;
  introduction: string;
  tagline: string;
  generatedStrengths: string[];
  representativeImage?: string;
  performanceImages: string[];
  performanceImageCategories: ProfileImageCategory[];
  externalImages: ExternalImageAsset[];
  extractedItems: ExtractedItem[];
  pdfPageAssets: PdfPageAsset[];
  deckPlan?: DeckPlan;
  deckPlanMeta?: DeckPlanMeta;
}

export type ProfileImageCategory = "activity" | "poster" | "history";

export const initialProfile: ProfileData = {
  source: null,
  artistName: "",
  artistType: "개인",
  primaryField: "",
  secondaryField: "",
  region: "",
  members: "",
  contact: "",
  videoUrl: "",
  careers: [{ id: "career-1", year: "", title: "", organization: "" }],
  strengths: [],
  experiences: [],
  impressions: [],
  tone: "전문적이고 명료하게",
  purpose: "공공기관 제안",
  pageCount: 6,
  templateKey: "modern_navy_01",
  introduction: "",
  tagline: "",
  generatedStrengths: [],
  performanceImages: [],
  performanceImageCategories: [],
  externalImages: [],
  extractedItems: [],
  pdfPageAssets: [],
};
