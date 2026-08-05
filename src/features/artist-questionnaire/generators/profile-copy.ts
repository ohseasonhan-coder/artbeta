import { ProfileData } from "@/types/profile";

export function generateLocalCopy(profile: ProfileData) {
  const name = profile.artistName.trim() || "이름을 입력한 예술인";
  const lastCharacter = name.charCodeAt(name.length - 1);
  const hasBatchim = lastCharacter >= 0xac00 && lastCharacter <= 0xd7a3 && (lastCharacter - 0xac00) % 28 !== 0;
  const topicParticle = hasBatchim ? "은" : "는";
  const field = profile.primaryField || "공연예술";
  const region = profile.region ? `${profile.region}을 중심으로 ` : "";
  const feature = profile.strengths[0] || profile.impressions[0] || "관객과 호흡하는 무대";
  const careerSummary = profile.careers.filter((career) => career.title.trim()).slice(0, 3).map((career) => career.title).join(", ");

  return {
    tagline: `${feature}, ${name}`,
    introduction: `${name}${topicParticle} ${region}활동하는 ${field} ${profile.artistType === "단체" ? "팀" : "예술인"}입니다. ${profile.purpose}에 어울리는 안정적인 구성과 진정성 있는 무대로 관객과 만납니다.${careerSummary ? ` 주요 활동으로 ${careerSummary} 등이 있습니다.` : ""}`,
    strengths: [
      profile.strengths[0] || `${field} 분야의 전문성`,
      profile.strengths[1] || "현장에 맞춘 유연한 프로그램 구성",
      profile.strengths[2] || "관객과 자연스럽게 호흡하는 진행",
    ],
  };
}
