import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 120_000;

type VerificationTier = "primary" | "platform" | "reference";

function isPrivateAddress(address: string) {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  if (isIP(normalized) !== 4) return true;
  const [a, b] = normalized.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("지원하지 않는 링크입니다.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("외부 공개 페이지 링크만 사용할 수 있습니다.");
  return url;
}

function classifySource(hostname: string): { sourceName: string; verificationTier: VerificationTier } {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (host === "namu.wiki" || host.endsWith(".namu.wiki")) return { sourceName: "나무위키", verificationTier: "reference" };
  if (host === "otr.co.kr" || host.endsWith(".otr.co.kr")) return { sourceName: "OTR", verificationTier: "platform" };
  if (host === "showgle.co.kr" || host.endsWith(".showgle.co.kr")) return { sourceName: "쇼글", verificationTier: "platform" };
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return { sourceName: "Instagram", verificationTier: "platform" };
  return { sourceName: hostname.replace(/^www\./, ""), verificationTier: "primary" };
}

function decodeHtml(value: string) {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", middot: "·" };
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return entities[entity.toLowerCase()] ?? match;
    })
    .replace(/\u00a0/g, " ");
}

function extractPage(html: string) {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
  const description = decodeHtml(
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1]
      ?? "",
  ).trim();
  const text = decodeHtml(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length >= 2)
    .filter((line, index, lines) => index === 0 || line !== lines[index - 1])
    .join("\n")
    .slice(0, MAX_TEXT_LENGTH);
  return { title, text: [title, description, text].filter(Boolean).join("\n") };
}

function decodePageBuffer(buffer: Buffer, contentType: string) {
  const head = buffer.subarray(0, 4_096).toString("ascii");
  const declared = contentType.match(/charset=["']?([^;"'\s]+)/i)?.[1]
    ?? head.match(/<meta[^>]+charset=["']?([^"'\s/>]+)/i)?.[1]
    ?? head.match(/<meta[^>]+content=["'][^"']*charset=([^;"'\s]+)/i)?.[1]
    ?? "utf-8";
  const charset = /euc-?kr|ks_c_5601|cp949/i.test(declared) ? "euc-kr" : declared;
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

async function fetchPage(initialUrl: URL) {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.6",
        "User-Agent": "Mozilla/5.0 (compatible; ArtistProfileStudio/1.0; +https://artbeta.vercel.app)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("페이지 이동 주소를 확인할 수 없습니다.");
      current = await assertPublicUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`원문 사이트가 자동 읽기를 허용하지 않았습니다. (${response.status})`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) throw new Error("웹 문서 형식의 링크만 자동 분석할 수 있습니다.");
    const declaredSize = Number(response.headers.get("content-length")) || 0;
    if (declaredSize > MAX_HTML_BYTES) throw new Error("페이지 내용이 너무 커서 자동 분석할 수 없습니다.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_HTML_BYTES) throw new Error("페이지 내용이 너무 커서 자동 분석할 수 없습니다.");
    return { finalUrl: current, html: decodePageBuffer(buffer, contentType) };
  }
  throw new Error("페이지 이동 횟수가 너무 많습니다.");
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { url?: string };
    const initialUrl = await assertPublicUrl(body.url?.trim() ?? "");
    const { finalUrl, html } = await fetchPage(initialUrl);
    const { title, text } = extractPage(html);
    if (text.replace(/\s+/g, " ").trim().length < 80) throw new Error("페이지에서 분석할 공개 문구를 충분히 찾지 못했습니다.");
    const source = classifySource(finalUrl.hostname);
    return NextResponse.json({
      url: finalUrl.toString(),
      title,
      text,
      sourceName: source.sourceName,
      verificationTier: source.verificationTier,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "외부 링크를 읽지 못했습니다.";
    return NextResponse.json({ error: message }, { status: /지원하지|공개 페이지|웹 문서/.test(message) ? 400 : 422 });
  }
}
