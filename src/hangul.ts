/**
 * Hangul decomposition and search token generation utilities for Telegram file indexing.
 */

export const DEFAULT_FULL_MODE_THRESHOLD = 10;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_MESSAGE_LIMIT = 4096;

const CHOSUNG = [
	"ㄱ",
	"ㄲ",
	"ㄴ",
	"ㄷ",
	"ㄸ",
	"ㄹ",
	"ㅁ",
	"ㅂ",
	"ㅃ",
	"ㅅ",
	"ㅆ",
	"ㅇ",
	"ㅈ",
	"ㅉ",
	"ㅊ",
	"ㅋ",
	"ㅌ",
	"ㅍ",
	"ㅎ",
] as const;

const JUNGSUNG = [
	"ㅏ",
	"ㅐ",
	"ㅑ",
	"ㅒ",
	"ㅓ",
	"ㅔ",
	"ㅕ",
	"ㅖ",
	"ㅗ",
	"ㅘ",
	"ㅙ",
	"ㅚ",
	"ㅛ",
	"ㅜ",
	"ㅝ",
	"ㅞ",
	"ㅟ",
	"ㅠ",
	"ㅡ",
	"ㅢ",
	"ㅣ",
] as const;

const JONGSUNG = [
	"",
	"ㄱ",
	"ㄲ",
	"ㄳ",
	"ㄴ",
	"ㄵ",
	"ㄶ",
	"ㄷ",
	"ㄹ",
	"ㄺ",
	"ㄻ",
	"ㄼ",
	"ㄽ",
	"ㄾ",
	"ㄿ",
	"ㅀ",
	"ㅁ",
	"ㅂ",
	"ㅄ",
	"ㅅ",
	"ㅆ",
	"ㅇ",
	"ㅈ",
	"ㅊ",
	"ㅋ",
	"ㅌ",
	"ㅍ",
	"ㅎ",
] as const;

const COMPOUND_JAMO_MAP: Record<string, readonly string[]> = {
	// Compound vowels (이중모음)
	"ㅘ": ["ㅗ", "ㅏ"],
	"ㅙ": ["ㅗ", "ㅐ"],
	"ㅚ": ["ㅗ", "ㅣ"],
	"ㅝ": ["ㅜ", "ㅓ"],
	"ㅞ": ["ㅜ", "ㅔ"],
	"ㅟ": ["ㅜ", "ㅣ"],
	"ㅢ": ["ㅡ", "ㅣ"],
	// Compound codas (겹받침)
	"ㄳ": ["ㄱ", "ㅅ"],
	"ㄵ": ["ㄴ", "ㅈ"],
	"ㄶ": ["ㄴ", "ㅎ"],
	"ㄺ": ["ㄹ", "ㄱ"],
	"ㄻ": ["ㄹ", "ㅁ"],
	"ㄼ": ["ㄹ", "ㅂ"],
	"ㄽ": ["ㄹ", "ㅅ"],
	"ㄾ": ["ㄹ", "ㅌ"],
	"ㄿ": ["ㄹ", "ㅍ"],
	"ㅀ": ["ㄹ", "ㅎ"],
	"ㅄ": ["ㅂ", "ㅅ"],
};

const WORD_SEPARATOR_REGEX = /[\s_\-.,;:!?()[\]{}<>/\\|+"'`~@#$%^&*=]+/u;
const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const COMPAT_CONSONANT_START = 0x3131;
const COMPAT_CONSONANT_END = 0x314e;
const COMPAT_JAMO_START = 0x3131;
const COMPAT_JAMO_END = 0x3163;

export interface SearchTokenResult {
	tokens: string[];
	text: string;
	mode: "full" | "ngram";
	effectiveLength: number;
}

export interface CaptionSplitResult {
	caption: string;
	followUpMessages: string[];
}

function isHangulSyllable(code: number): boolean {
	return code >= HANGUL_SYLLABLE_START && code <= HANGUL_SYLLABLE_END;
}

function isCompatConsonant(code: number): boolean {
	return code >= COMPAT_CONSONANT_START && code <= COMPAT_CONSONANT_END;
}

function isCompatJamo(code: number): boolean {
	return code >= COMPAT_JAMO_START && code <= COMPAT_JAMO_END;
}

function hasHangul(word: string): boolean {
	for (const ch of word) {
		const code = ch.codePointAt(0);
		if (code !== undefined && (isHangulSyllable(code) || isCompatJamo(code))) {
			return true;
		}
	}
	return false;
}

/**
 * Normalizes a filename to NFC and removes its trailing extension (e.g., ".pdf"),
 * preserving dotfiles like ".gitignore".
 */
export function stripFileExtension(fileName: string): string {
	const normalized = fileName.trim().normalize("NFC");
	const lastDot = normalized.lastIndexOf(".");
	if (lastDot > 0 && lastDot < normalized.length - 1) {
		return normalized.slice(0, lastDot);
	}
	return normalized;
}

/**
 * Splits a normalized filename stem into non-empty word segments by common delimiters.
 */
export function splitIntoWords(stem: string): string[] {
	return stem
		.normalize("NFC")
		.split(WORD_SEPARATOR_REGEX)
		.filter((segment) => segment.length > 0);
}

/**
 * Extracts Hangul chosung (initial consonants) from a word.
 */
export function extractChosung(word: string): string {
	const normalized = word.normalize("NFC");
	let result = "";
	for (const ch of normalized) {
		const code = ch.codePointAt(0);
		if (code === undefined) continue;
		if (isHangulSyllable(code)) {
			const choIdx = Math.floor((code - HANGUL_SYLLABLE_START) / 588);
			result += CHOSUNG[choIdx];
		} else if (isCompatConsonant(code)) {
			result += ch;
		}
	}
	return result;
}

/**
 * Decomposes a word containing Hangul into individual 2-bulsik jamo units,
 * expanding compound vowels (이중모음) and compound codas (겹받침).
 * Pure non-Hangul words return an empty array.
 */
export function decomposeToJamo(word: string): string[] {
	const normalized = word.normalize("NFC");
	if (!hasHangul(normalized)) {
		return [];
	}

	const jamos: string[] = [];
	for (const ch of normalized) {
		const code = ch.codePointAt(0);
		if (code === undefined) continue;

		if (isHangulSyllable(code)) {
			const offset = code - HANGUL_SYLLABLE_START;
			const choIdx = Math.floor(offset / 588);
			const jungIdx = Math.floor((offset % 588) / 28);
			const jongIdx = offset % 28;

			jamos.push(CHOSUNG[choIdx]);

			const jung = JUNGSUNG[jungIdx];
			jamos.push(...(COMPOUND_JAMO_MAP[jung] ?? [jung]));

			const jong = JONGSUNG[jongIdx];
			if (jong) {
				jamos.push(...(COMPOUND_JAMO_MAP[jong] ?? [jong]));
			}
		} else if (isCompatJamo(code)) {
			jamos.push(...(COMPOUND_JAMO_MAP[ch] ?? [ch]));
		} else {
			jamos.push(ch);
		}
	}
	return jamos;
}

/**
 * Generates all contiguous substrings (N-grams) for a word in start-index order.
 */
export function generateWordNGrams(word: string): string[] {
	const chars = Array.from(word);
	const ngrams: string[] = [];
	for (let i = 0; i < chars.length; i++) {
		for (let j = i + 1; j <= chars.length; j++) {
			ngrams.push(chars.slice(i, j).join(""));
		}
	}
	return ngrams;
}

/**
 * Generates cumulative prefixes from a sequence of units (e.g., ["ㅎ","ㄱ"] -> ["ㅎ","ㅎㄱ"]).
 */
export function generatePrefixAccumulations(items: readonly string[]): string[] {
	const prefixes: string[] = [];
	let acc = "";
	for (const item of items) {
		acc += item;
		prefixes.push(acc);
	}
	return prefixes;
}

/**
 * Generates deduplicated search tokens for a filename.
 * Uses full mode (N-gram + chosung + jamo) when effective character count <= threshold,
 * and N-gram-only mode when > threshold.
 */
export function generateSearchTokens(
	fileName: string,
	threshold: number = DEFAULT_FULL_MODE_THRESHOLD,
): SearchTokenResult {
	const stem = stripFileExtension(fileName);
	const words = splitIntoWords(stem);
	const effectiveLength = words.reduce((sum, w) => sum + Array.from(w).length, 0);
	const mode: "full" | "ngram" = effectiveLength <= threshold ? "full" : "ngram";

	const seen = new Set<string>();
	const addTokens = (candidates: readonly string[]) => {
		for (const token of candidates) {
			if (token && !seen.has(token)) {
				seen.add(token);
			}
		}
	};

	// 1. Word-level character N-grams (partial & cumulative syllables)
	for (const word of words) {
		addTokens(generateWordNGrams(word));
	}

	// 2 & 3. Chosung accumulation and Jamo accumulation only in full mode
	if (mode === "full") {
		for (const word of words) {
			if (!hasHangul(word)) continue;
			const chosungChars = Array.from(extractChosung(word));
			addTokens(generatePrefixAccumulations(chosungChars));
		}

		for (const word of words) {
			const jamoChars = decomposeToJamo(word);
			if (jamoChars.length === 0) continue;
			addTokens(generatePrefixAccumulations(jamoChars));
		}
	}

	const tokens = Array.from(seen);
	return {
		tokens,
		text: tokens.join(" "),
		mode,
		effectiveLength,
	};
}

function codePointLength(str: string): number {
	return Array.from(str).length;
}

function sliceByCodePoints(str: string, maxLen: number): string {
	return Array.from(str).slice(0, maxLen).join("");
}

/**
 * Splits a single token that exceeds maxLen into chunks of at most maxLen code points.
 */
function splitOversizedToken(token: string, maxLen: number): string[] {
	const chars = Array.from(token);
	const chunks: string[] = [];
	for (let i = 0; i < chars.length; i += maxLen) {
		chunks.push(chars.slice(i, i + maxLen).join(""));
	}
	return chunks;
}

/**
 * Packs space-separated tokens into chunks of at most `maxLen` code points,
 * returning the consumed index or packing all tokens into an array of messages.
 */
function packTokensUpToLimit(
	tokens: readonly string[],
	startIndex: number,
	maxLen: number,
): { chunk: string; nextIndex: number } {
	if (startIndex >= tokens.length || maxLen <= 0) {
		return { chunk: "", nextIndex: startIndex };
	}

	const selected: string[] = [];
	let currentLen = 0;
	let idx = startIndex;

	while (idx < tokens.length) {
		const token = tokens[idx];
		const tokenLen = codePointLength(token);
		const neededLen = selected.length === 0 ? tokenLen : tokenLen + 1;

		if (currentLen + neededLen <= maxLen) {
			selected.push(token);
			currentLen += neededLen;
			idx++;
		} else {
			break;
		}
	}

	return {
		chunk: selected.join(" "),
		nextIndex: idx,
	};
}

/**
 * Splits search tokens into a Telegram media caption (<= 1024 chars) and
 * follow-up text messages (<= 4096 chars each) at token boundaries.
 * Preserves any non-empty original caption at the start of the media caption.
 */
export function splitCaptionAndFollowUps(
	searchText: string,
	originalCaption?: string,
	captionLimit: number = TELEGRAM_CAPTION_LIMIT,
	messageLimit: number = TELEGRAM_MESSAGE_LIMIT,
): CaptionSplitResult {
	const trimmedSearch = searchText.trim();
	const trimmedOriginal = originalCaption?.trim() ?? "";

	const rawTokens = trimmedSearch.length > 0 ? trimmedSearch.split(/\s+/) : [];
	const tokens: string[] = [];
	for (const token of rawTokens) {
		if (codePointLength(token) > messageLimit) {
			tokens.push(...splitOversizedToken(token, messageLimit));
		} else {
			tokens.push(token);
		}
	}

	let caption = "";
	let nextIdx = 0;

	if (trimmedOriginal.length > 0) {
		const origLen = codePointLength(trimmedOriginal);
		if (origLen >= captionLimit) {
			caption = sliceByCodePoints(trimmedOriginal, captionLimit);
		} else {
			const separator = "\n\n";
			const remainingBudget = captionLimit - origLen - separator.length;
			const packed = packTokensUpToLimit(tokens, 0, remainingBudget);
			if (packed.chunk.length > 0) {
				caption = `${trimmedOriginal}${separator}${packed.chunk}`;
				nextIdx = packed.nextIndex;
			} else {
				caption = trimmedOriginal;
			}
		}
	} else if (tokens.length > 0) {
		if (codePointLength(tokens[0]) > captionLimit) {
			// Single oversized token cannot fit into captionLimit; keep caption empty and send in follow-up
			nextIdx = 0;
		} else {
			const packed = packTokensUpToLimit(tokens, 0, captionLimit);
			caption = packed.chunk;
			nextIdx = packed.nextIndex;
		}
	}

	const followUpMessages: string[] = [];
	while (nextIdx < tokens.length) {
		const packed = packTokensUpToLimit(tokens, nextIdx, messageLimit);
		if (packed.chunk.length === 0) {
			// Safety guard against stall if a token exceeds messageLimit
			const fallback = sliceByCodePoints(tokens[nextIdx], messageLimit);
			if (fallback.length > 0) {
				followUpMessages.push(fallback);
			}
			nextIdx++;
		} else {
			followUpMessages.push(packed.chunk);
			nextIdx = packed.nextIndex;
		}
	}

	return {
		caption,
		followUpMessages,
	};
}
