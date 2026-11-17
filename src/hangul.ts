/**
 * Hangul decomposition and search token generation utilities for Telegram file indexing.
 */

export const DEFAULT_FULL_MODE_THRESHOLD = 10;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const MAX_FOLLOW_UP_MESSAGES = 2;
// Include the spaces between the caption and replies in the generated token text.
export const MAX_SEARCH_TEXT_LENGTH = TELEGRAM_CAPTION_LIMIT + MAX_FOLLOW_UP_MESSAGES * (TELEGRAM_MESSAGE_LIMIT + 1);

const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'] as const;

const JUNGSUNG = [
	'ㅏ',
	'ㅐ',
	'ㅑ',
	'ㅒ',
	'ㅓ',
	'ㅔ',
	'ㅕ',
	'ㅖ',
	'ㅗ',
	'ㅘ',
	'ㅙ',
	'ㅚ',
	'ㅛ',
	'ㅜ',
	'ㅝ',
	'ㅞ',
	'ㅟ',
	'ㅠ',
	'ㅡ',
	'ㅢ',
	'ㅣ',
] as const;

const JONGSUNG = [
	'',
	'ㄱ',
	'ㄲ',
	'ㄳ',
	'ㄴ',
	'ㄵ',
	'ㄶ',
	'ㄷ',
	'ㄹ',
	'ㄺ',
	'ㄻ',
	'ㄼ',
	'ㄽ',
	'ㄾ',
	'ㄿ',
	'ㅀ',
	'ㅁ',
	'ㅂ',
	'ㅄ',
	'ㅅ',
	'ㅆ',
	'ㅇ',
	'ㅈ',
	'ㅊ',
	'ㅋ',
	'ㅌ',
	'ㅍ',
	'ㅎ',
] as const;

const COMPOUND_JAMO_MAP: Record<string, readonly string[]> = {
	// Compound vowels (이중모음)
	ㅘ: ['ㅗ', 'ㅏ'],
	ㅙ: ['ㅗ', 'ㅐ'],
	ㅚ: ['ㅗ', 'ㅣ'],
	ㅝ: ['ㅜ', 'ㅓ'],
	ㅞ: ['ㅜ', 'ㅔ'],
	ㅟ: ['ㅜ', 'ㅣ'],
	ㅢ: ['ㅡ', 'ㅣ'],
	// Compound codas (겹받침)
	ㄳ: ['ㄱ', 'ㅅ'],
	ㄵ: ['ㄴ', 'ㅈ'],
	ㄶ: ['ㄴ', 'ㅎ'],
	ㄺ: ['ㄹ', 'ㄱ'],
	ㄻ: ['ㄹ', 'ㅁ'],
	ㄼ: ['ㄹ', 'ㅂ'],
	ㄽ: ['ㄹ', 'ㅅ'],
	ㄾ: ['ㄹ', 'ㅌ'],
	ㄿ: ['ㄹ', 'ㅍ'],
	ㅀ: ['ㄹ', 'ㅎ'],
	ㅄ: ['ㅂ', 'ㅅ'],
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
	mode: 'full' | 'ngram';
	effectiveLength: number;
}

export interface CaptionSplitResult {
	caption: string;
	followUpMessages: string[];
	/** Keep the source media intact; follow-ups contain all search tokens. */
	preserveOriginal: boolean;
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
	const normalized = fileName.trim().normalize('NFC');
	const lastDot = normalized.lastIndexOf('.');
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
		.normalize('NFC')
		.split(WORD_SEPARATOR_REGEX)
		.filter((segment) => segment.length > 0);
}

/**
 * Extracts Hangul chosung (initial consonants) from a word.
 */
export function extractChosung(word: string): string {
	const normalized = word.normalize('NFC');
	let result = '';
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
	const normalized = word.normalize('NFC');
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
	return Array.from(iterateWordNGrams(word));
}

function* iterateWordNGrams(word: string): Generator<string> {
	const chars = Array.from(word);
	for (let i = 0; i < chars.length; i++) {
		for (let j = i + 1; j <= chars.length; j++) {
			yield chars.slice(i, j).join('');
		}
	}
}

/**
 * Generates cumulative prefixes from a sequence of units (e.g., ["ㅎ","ㄱ"] -> ["ㅎ","ㅎㄱ"]).
 */
export function generatePrefixAccumulations(items: readonly string[]): string[] {
	return Array.from(iteratePrefixAccumulations(items));
}

function* iteratePrefixAccumulations(items: readonly string[]): Generator<string> {
	let acc = '';
	for (const item of items) {
		acc += item;
		yield acc;
	}
}

/**
 * Generates deduplicated search tokens for a filename.
 * Uses full mode (N-gram + chosung + jamo) when effective character count <= threshold,
 * and N-gram-only mode when > threshold.
 * Stops at the first new token exceeding the output budget, retaining a prefix
 * of the original order without materializing all substring candidates.
 */
export function generateSearchTokens(fileName: string, threshold: number = DEFAULT_FULL_MODE_THRESHOLD): SearchTokenResult {
	const stem = stripFileExtension(fileName);
	const words = splitIntoWords(stem);
	const effectiveLength = words.reduce((sum, w) => sum + Array.from(w).length, 0);
	const mode: 'full' | 'ngram' = effectiveLength <= threshold ? 'full' : 'ngram';

	const seen = new Set<string>();
	let textLength = 0;
	const result = (): SearchTokenResult => {
		const tokens = Array.from(seen);
		return { tokens, text: tokens.join(' '), mode, effectiveLength };
	};
	const addTokens = (candidates: Iterable<string>): boolean => {
		for (const token of candidates) {
			if (token && !seen.has(token)) {
				const needed = codePointLength(token) + (seen.size > 0 ? 1 : 0);
				if (textLength + needed > MAX_SEARCH_TEXT_LENGTH) return false;
				seen.add(token);
				textLength += needed;
			}
		}
		return true;
	};

	// 1. Word-level character N-grams (partial & cumulative syllables)
	for (const word of words) {
		if (!addTokens(iterateWordNGrams(word))) return result();
	}

	// 2 & 3. Chosung accumulation and Jamo accumulation only in full mode
	if (mode === 'full') {
		for (const word of words) {
			if (!hasHangul(word)) continue;
			const chosungChars = Array.from(extractChosung(word));
			if (!addTokens(iteratePrefixAccumulations(chosungChars))) return result();
		}

		for (const word of words) {
			const jamoChars = decomposeToJamo(word);
			if (jamoChars.length === 0) continue;
			if (!addTokens(iteratePrefixAccumulations(jamoChars))) return result();
		}
	}

	return result();
}

function codePointLength(str: string): number {
	return Array.from(str).length;
}

function sliceByCodePoints(str: string, maxLen: number): string {
	return Array.from(str).slice(0, maxLen).join('');
}

/**
 * Splits a single token that exceeds maxLen into chunks of at most maxLen code points.
 */
function splitOversizedToken(token: string, maxLen: number): string[] {
	const chars = Array.from(token);
	const chunks: string[] = [];
	for (let i = 0; i < chars.length; i += maxLen) {
		chunks.push(chars.slice(i, i + maxLen).join(''));
	}
	return chunks;
}

/**
 * Packs space-separated tokens into chunks of at most `maxLen` code points,
 * returning the consumed index or packing all tokens into an array of messages.
 */
function packTokensUpToLimit(tokens: readonly string[], startIndex: number, maxLen: number): { chunk: string; nextIndex: number } {
	if (startIndex >= tokens.length || maxLen <= 0) {
		return { chunk: '', nextIndex: startIndex };
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
		chunk: selected.join(' '),
		nextIndex: idx,
	};
}

/**
 * Splits search tokens into a Telegram media caption (<= 1024 chars) and
 * at most two follow-up text messages (<= 4096 chars each) at token boundaries.
 * Keeps tokens in order and discards any remaining search tokens after the cap.
 * Keeps the original caption byte-for-byte so UTF-16 entity offsets remain valid.
 * If it cannot fit, instructs the caller to retain the source instead of truncating it.
 */
export function splitCaptionAndFollowUps(
	searchText: string,
	originalCaption?: string,
	captionLimit: number = TELEGRAM_CAPTION_LIMIT,
	messageLimit: number = TELEGRAM_MESSAGE_LIMIT,
): CaptionSplitResult {
	const trimmedSearch = searchText.trim();
	const original = originalCaption ?? '';
	const preserveOriginal = codePointLength(original) > captionLimit;

	const rawTokens = trimmedSearch.length > 0 ? trimmedSearch.split(/\s+/) : [];
	const tokens: string[] = [];
	for (const token of rawTokens) {
		if (codePointLength(token) > messageLimit) {
			tokens.push(...splitOversizedToken(token, messageLimit));
		} else {
			tokens.push(token);
		}
	}

	let caption = '';
	let nextIdx = 0;

	if (preserveOriginal) {
		// Leave the source caption and its entities untouched; only send search replies.
		nextIdx = 0;
	} else if (original.length > 0) {
		const origLen = codePointLength(original);
		if (origLen === captionLimit) {
			caption = original;
		} else {
			const separator = '\n\n';
			const remainingBudget = captionLimit - origLen - separator.length;
			const packed = packTokensUpToLimit(tokens, 0, remainingBudget);
			if (packed.chunk.length > 0) {
				caption = `${original}${separator}${packed.chunk}`;
				nextIdx = packed.nextIndex;
			} else {
				caption = original;
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
	while (nextIdx < tokens.length && followUpMessages.length < MAX_FOLLOW_UP_MESSAGES) {
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
		preserveOriginal,
	};
}
