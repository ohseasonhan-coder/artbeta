import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { generateLocalCopy } from "@/features/artist-questionnaire/generators/profile-copy";
import { ProfileData } from "@/types/profile";

const copySchema = z.object({
  tagline: z.string(),
  introduction: z.string(),
  strengths: z.array(z.string()).length(3),
});

async function generateWithGemini(facts: object) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    contents: `입력 사실만 사용하는 문화예술인 프로필 에디터입니다. 없는 경력, 날짜, 기관명, 수상, 인원, 출연료, 장비를 만들지 않습니다. 구체적인 고유명사와 실제 경력을 살려 자연스러운 한국어 문구를 작성하세요.\n\n${JSON.stringify(facts)}`,
    config: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(copySchema) },
  });
  return copySchema.parse(JSON.parse(response.text || "{}"));
}

async function generateWithOpenAI(facts: object) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.parse({
    model: process.env.OPENAI_MODEL || "gpt-5.6-sol",
    store: false,
    input: [
      { role: "system", content: "입력 사실만 사용하는 문화예술인 프로필 에디터입니다. 없는 경력, 날짜, 기관명, 수상, 인원, 출연료, 장비를 만들지 않습니다. 구체적인 고유명사와 실제 경력을 살려 자연스러운 한국어 문구를 작성합니다." },
      { role: "user", content: JSON.stringify(facts) },
    ],
    text: { format: zodTextFormat(copySchema, "artist_profile_copy") },
  });
  if (!response.output_parsed) throw new Error("OpenAI가 문구를 반환하지 않았습니다.");
  return response.output_parsed;
}

export async function POST(request: Request) {
  const profile = (await request.json()) as ProfileData;
  const fallback = generateLocalCopy(profile);
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) return NextResponse.json({ ...fallback, mode: "local" });

  try {
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
    let parsed: z.infer<typeof copySchema>;
    let provider: "gemini" | "openai";
    if (process.env.GEMINI_API_KEY) {
      try {
        parsed = await generateWithGemini(facts);
        provider = "gemini";
      } catch (geminiError) {
        console.error("Gemini copy generation failed", geminiError);
        if (!process.env.OPENAI_API_KEY) throw geminiError;
        parsed = await generateWithOpenAI(facts);
        provider = "openai";
      }
    } else {
      parsed = await generateWithOpenAI(facts);
      provider = "openai";
    }
    return NextResponse.json({ ...fallback, ...parsed, mode: "ai", provider });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ ...fallback, mode: "local", warning: "AI 연결에 실패해 규칙 기반 문구를 사용했습니다." });
  }
}
