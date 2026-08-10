import type { Metadata } from "next";
import TeamBoard from "@/features/team-board/components/TeamBoard";

export const metadata: Metadata = {
  title: "팀원 찾기 | 아트폴리오",
  description: "예술인 프로필을 바탕으로 팀원을 모집하고 프로젝트에 합류하세요.",
};

export default function TeamPage() {
  return <TeamBoard />;
}
