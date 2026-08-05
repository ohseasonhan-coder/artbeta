import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "아트폴리오 | 예술인 프로필 스튜디오",
  description: "자료가 있어도 없어도, 예술인의 이야기를 완성하는 프로필 제작 도구",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}

