import { NextResponse } from "next/server";
import OpenAI from "openai";
import { generateLocalCopy } from "@/features/artist-questionnaire/generators/profile-copy";
import { ProfileData } from "@/types/profile";

export async function POST(request: Request) {
  const profile = (await request.json()) as ProfileData;
  const fallback = generateLocalCopy(profile);
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ ...fallback, mode: "local" });

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const facts = {
      artistName: profile.artistName,
      artistType: profile.artistType,
      primaryField: profile.primaryField,
      secondaryField: profile.secondaryField,
      region: profile.region,
      careers: profile.careers.filter((item) => item.title),
      strengths: profile.strengths,
      experiences: profile.experiences,
      impressions: profile.impressions,
      purpose: profile.purpose,
      tone: profile.tone,
    };
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "입력 사실만 사용하는 문화예술인 프로필 에디터다. 없는 경력, 날짜, 기관명, 수상, 인원, 출연료, 장비를 만들지 않는다. 한국어 JSON으로 tagline, introduction, strengths(문자열 3개)를 반환한다." },
        { role: "user", content: JSON.stringify(facts) },
      ],
    });
    const parsed = JSON.parse(response.choices[0]?.message.content || "{}");
    return NextResponse.json({ ...fallback, ...parsed, mode: "ai" });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ ...fallback, mode: "local", warning: "AI 연결에 실패해 규칙 기반 문구를 사용했습니다." });
  }
}

