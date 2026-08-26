const INTERNAL_COPY_PATTERNS = [
  /(?:^|[\s·|｜,;/()])(?:원문\s*)?\d+\s*(?:p|페이지|슬라이드)(?=$|[\s·|｜,;/()])/gi,
  /\b(?:PHOTO\s*BRIEF|VERIFIED)\b/gi,
  /(?:이미지|사진)\s*(?:준비|삽입|교체|자리)/gi,
  /(?:사실\s*확인\s*필요|입력해\s*주세요)/gi,
] as const;

export interface KoreanTextFitOptions {
  maxWidth: number;
  maxLines: number;
  preferredFontSize: number;
  minFontSize: number;
  ellipsis?: boolean;
}

export interface KoreanTextFitResult {
  text: string;
  fontSize: number;
  lineCount: number;
  truncated: boolean;
}

export interface KoreanTextBoxInchesOptions {
  widthInches: number;
  heightInches: number;
  maxLines: number;
  preferredFontSize: number;
  minFontSize: number;
  lineHeight?: number;
  ellipsis?: boolean;
}

function graphemes(value: string) {
  return Array.from(value);
}

export function normalizeKoreanDisplayText(value: string) {
  let text = String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, " ")
    .replace(/\r?\n+/g, " ");
  INTERNAL_COPY_PATTERNS.forEach((pattern) => { text = text.replace(pattern, " "); });
  return text
    .replace(/\s*([·|｜])\s*/g, " · ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/^\s*[·|｜,;/]+|[·|｜,;/]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function koreanTextWidth(value: string) {
  return graphemes(value).reduce((width, character) => {
    if (/\s/.test(character)) return width + 0.38;
    if (/[가-힣ㄱ-ㅎㅏ-ㅣ一-龥ぁ-んァ-ヶ]/.test(character)) return width + 1;
    if (/[A-Z0-9]/.test(character)) return width + 0.66;
    if (/[a-z]/.test(character)) return width + 0.54;
    if (/[,.;:!?·|｜/()\[\]{}'"-]/.test(character)) return width + 0.42;
    return width + 1;
  }, 0);
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[\s.,·|｜;:!?\-–—]+$/g, "").trim();
}

function truncateToWidth(value: string, maxWidth: number, ellipsis = true) {
  const text = normalizeKoreanDisplayText(value);
  if (koreanTextWidth(text) <= maxWidth) return { text, truncated: false };
  const suffix = ellipsis ? "…" : "";
  const suffixWidth = koreanTextWidth(suffix);
  let output = "";
  for (const character of graphemes(text)) {
    if (koreanTextWidth(output + character) > Math.max(1, maxWidth - suffixWidth)) break;
    output += character;
  }
  return { text: `${trimTrailingPunctuation(output)}${suffix}`, truncated: true };
}

function wrapAtKoreanWordBoundaries(value: string, maxWidth: number, maxLines: number, ellipsis = true) {
  const text = normalizeKoreanDisplayText(value);
  if (!text || maxLines <= 0 || maxWidth <= 0) return { lines: [] as string[], truncated: Boolean(text) };
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  let truncated = false;

  for (let index = 0; index < words.length; index += 1) {
    const rawWord = words[index];
    const word = koreanTextWidth(rawWord) > maxWidth ? truncateToWidth(rawWord, maxWidth, ellipsis).text : rawWord;
    const next = current ? `${current} ${word}` : word;
    if (!current || koreanTextWidth(next) <= maxWidth) {
      current = next;
      if (word !== rawWord) truncated = true;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) {
      truncated = true;
      break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }
  if (truncated && lines.length && ellipsis) {
    const withoutSuffix = truncateToWidth(`${trimTrailingPunctuation(lines[lines.length - 1])}…`, maxWidth, true).text;
    lines[lines.length - 1] = withoutSuffix.endsWith("…") ? withoutSuffix : `${trimTrailingPunctuation(withoutSuffix)}…`;
  }
  return { lines, truncated };
}

export function fitKoreanTextBox(value: string, options: KoreanTextFitOptions): KoreanTextFitResult {
  const preferred = Math.max(options.minFontSize, options.preferredFontSize);
  const minimum = Math.min(preferred, options.minFontSize);
  for (let fontSize = preferred; fontSize >= minimum; fontSize -= 1) {
    const scaledWidth = options.maxWidth * preferred / fontSize;
    const wrapped = wrapAtKoreanWordBoundaries(value, scaledWidth, options.maxLines, options.ellipsis ?? true);
    if (!wrapped.truncated) return { text: wrapped.lines.join("\n"), fontSize, lineCount: wrapped.lines.length, truncated: false };
  }
  const wrapped = wrapAtKoreanWordBoundaries(value, options.maxWidth * preferred / minimum, options.maxLines, options.ellipsis ?? true);
  return { text: wrapped.lines.join("\n"), fontSize: minimum, lineCount: wrapped.lines.length, truncated: wrapped.truncated };
}

/**
 * Fits Korean copy against the actual PowerPoint text-box geometry.
 * A conservative width factor is intentional: Office font metrics vary by
 * platform, so the generated copy must still fit after font substitution.
 */
export function fitKoreanTextBoxInches(value: string, options: KoreanTextBoxInchesOptions): KoreanTextFitResult {
  const preferred = Math.max(options.minFontSize, options.preferredFontSize);
  const minimum = Math.min(preferred, options.minFontSize);
  const lineHeight = Math.max(1.12, options.lineHeight ?? 1.2);
  const widthSafety = 0.84;
  for (let fontSize = preferred; fontSize >= minimum; fontSize -= 1) {
    const heightLines = Math.floor(options.heightInches * 72 / (fontSize * lineHeight));
    const allowedLines = Math.min(options.maxLines, heightLines);
    if (allowedLines < 1) continue;
    const maxWidth = options.widthInches * 72 / fontSize * widthSafety;
    const wrapped = wrapAtKoreanWordBoundaries(value, maxWidth, allowedLines, options.ellipsis ?? true);
    if (!wrapped.truncated) return { text: wrapped.lines.join("\n"), fontSize, lineCount: wrapped.lines.length, truncated: false };
  }
  const heightLines = Math.max(1, Math.floor(options.heightInches * 72 / (minimum * lineHeight)));
  const allowedLines = Math.max(1, Math.min(options.maxLines, heightLines));
  const maxWidth = options.widthInches * 72 / minimum * widthSafety;
  const wrapped = wrapAtKoreanWordBoundaries(value, maxWidth, allowedLines, options.ellipsis ?? true);
  return { text: wrapped.lines.join("\n"), fontSize: minimum, lineCount: wrapped.lines.length, truncated: wrapped.truncated };
}

export function compactKoreanText(value: string, maxWidth: number) {
  return truncateToWidth(value, maxWidth, true).text;
}

export function oneLineKoreanText(value: string, maxWidth: number) {
  return fitKoreanTextBox(value, { maxWidth, maxLines: 1, preferredFontSize: 16, minFontSize: 16 }).text.replace(/\n/g, " ");
}
