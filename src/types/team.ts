export type TeamPostType = "recruit" | "join";
export type TeamPostStatus = "open" | "closed";
export type CompensationType = "paid" | "negotiable" | "exchange" | "volunteer";

export interface TeamPost {
  id: string;
  postType: TeamPostType;
  status: TeamPostStatus;
  title: string;
  artistName: string;
  primaryField: string;
  region: string;
  wantedRole: string;
  headcount: number;
  activityType: string;
  projectDate: string;
  compensation: CompensationType;
  description: string;
  highlights: string[];
  profileImage: string;
  profileUrl: string;
  contact: string;
  createdAt: string;
  isDemo?: boolean;
}

export type TeamPostInput = Omit<TeamPost, "id" | "status" | "createdAt" | "isDemo"> & { website?: string };
