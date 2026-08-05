import { NextResponse } from "next/server";

export function GET() {
  if (process.env.GEMINI_API_KEY) {
    return NextResponse.json({ configured: true, provider: "Gemini", model: process.env.GEMINI_MODEL || "gemini-3.6-flash" });
  }
  if (process.env.OPENAI_API_KEY) {
    return NextResponse.json({ configured: true, provider: "OpenAI", model: process.env.OPENAI_MODEL || "gpt-5.6-sol" });
  }
  return NextResponse.json({ configured: false, provider: "기본 OCR", model: "로컬 분석" });
}
