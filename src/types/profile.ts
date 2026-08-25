export type SourceType = "pdf" | "questionnaire" | "unsure";
export type ReviewStatus = "approved" | "edited" | "excluded" | "needs_review";

export interface Career {
  id: string;
  year: string;
  title: string;
  organization: string;
  sourceName?: string;
  sourceUrl?: string;
  verificationTier?: "primary" | "platform" | "reference";
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
    | "performance_duration"
    | "cast_size"
    | "technical_requirement"
    | "repertoire"
    | "program_configuration"
    | "strength"
    | "region";
  label: string;
  value: string;
  confidence: number;
  status: ReviewStatus;
  pageNumber?: number;
  sourceName?: string;
  sourceUrl?: string;
  verificationTier?: "primary" | "platform" | "reference";
}

export interface PdfPageAsset {
  pageNumber: number;
  previewDataUrl: string;
  text: string;
  textSource: "embedded" | "ocr" | "none";
  confidence: number;
  selected: boolean;
  extractedVisuals?: PdfExtractedVisual[];
}

export interface PdfExtractedVisual {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  kind: "photo" | "graphic";
  role?: ProfileVisualRole;
  relevanceScore?: number;
  qualityScore?: number;
  classificationReason?: string;
  duplicateOf?: string;
  selected: boolean;
}

export interface ExternalImageAsset {
  id: string;
  dataUrl: string;
  source: "naver" | "google" | "youtube" | "wikimedia" | "ai";
  sourceUrl?: string;
  title: string;
  relevanceScore: number;
  qualityScore: number;
  visualRole?: ProfileVisualRole;
  identityScore?: number;
  visualMatchScore?: number;
  identityReason?: string;
  referenceSignals?: string[];
  disclosure?: string;
  promptBasis?: string;
  watermarkDetected?: boolean;
  usageStatus?: "approved" | "review" | "blocked";
}

export type ProfileVisualRole = "portrait" | "stage" | "poster" | "history" | "other" | "exclude";

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
  promptVersion?: string;
  warning?: string;
  errorCode?: string;
  qualityScore?: number;
  coveredFactCount?: number;
  totalFactCount?: number;
  qualityChecks?: DeckQualityCheck[];
  qualityIssues?: string[];
}

export interface DeckQualityCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ProfileData {
  source: SourceType | null;
  artistName: string;
  artistType: "개인" | "단체";
  primaryField: string;
  secondaryField: string;
  region: string;
  affiliation: string;
  activeSince: string;
  identityHint: string;
  officialUrl: string;
  members: string;
  contact: string;
  videoUrl: string;
  performanceDuration: string;
  castSize: string;
  technicalRequirements: string[];
  careers: Career[];
  strengths: string[];
  experiences: string[];
  impressions: string[];
  tone: string;
  purpose: string;
  pageCount: number;
  templateKey: string;
  templateMode: "auto" | "manual";
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
  affiliation: "",
  activeSince: "",
  identityHint: "",
  officialUrl: "",
  members: "",
  contact: "",
  videoUrl: "",
  performanceDuration: "",
  castSize: "",
  technicalRequirements: [],
  careers: [{ id: "career-1", year: "", title: "", organization: "" }],
  strengths: [],
  experiences: [],
  impressions: [],
  tone: "전문적이고 명료하게",
  purpose: "공공기관 제안",
  pageCount: 10,
  templateKey: "modern_navy_01",
  templateMode: "auto",
  introduction: "",
  tagline: "",
  generatedStrengths: [],
  performanceImages: [],
  performanceImageCategories: [],
  externalImages: [],
  extractedItems: [],
  pdfPageAssets: [],
};
