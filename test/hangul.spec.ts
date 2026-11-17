import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FULL_MODE_THRESHOLD,
	MAX_SEARCH_TEXT_LENGTH,
	TELEGRAM_CAPTION_LIMIT,
	TELEGRAM_MESSAGE_LIMIT,
	decomposeToJamo,
	extractChosung,
	generateSearchTokens,
	generateWordNGrams,
	splitCaptionAndFollowUps,
	splitIntoWords,
	stripFileExtension,
} from '../src/hangul';

describe('hangul search token generator', () => {
	it('generates exact expected output for 한국.pdf', () => {
		const result = generateSearchTokens('한국.pdf');
		expect(result.mode).toBe('full');
		expect(result.effectiveLength).toBe(2);
		expect(result.text).toBe('한 한국 국 ㅎ ㅎㄱ ㅎㅏ ㅎㅏㄴ ㅎㅏㄴㄱ ㅎㅏㄴㄱㅜ ㅎㅏㄴㄱㅜㄱ');
	});

	it('normalizes macOS NFD filenames to NFC before processing', () => {
		const nfdName = '한국.pdf'.normalize('NFD');
		const nfcResult = generateSearchTokens('한국.pdf');
		const nfdResult = generateSearchTokens(nfdName);
		expect(nfdResult).toEqual(nfcResult);
	});

	it('decomposes compound vowels and compound codas into 2-bulsik single jamo', () => {
		expect(generateSearchTokens('과.pdf').text).toBe('과 ㄱ ㄱㅗ ㄱㅗㅏ');
		expect(generateSearchTokens('닭.pdf').text).toBe('닭 ㄷ ㄷㅏ ㄷㅏㄹ ㄷㅏㄹㄱ');

		const multi = generateSearchTokens('외국_값.pdf');
		expect(multi.mode).toBe('full');
		expect(multi.effectiveLength).toBe(3);
		// Words: ["외국", "값"]
		// N-grams: 외, 외국, 국, 값
		// Chosung: ㅇ, ㅇㄱ, ㄱ
		// Jamo: ㅇㅗ, ㅇㅗㅣ, ㅇㅗㅣㄱ, ㅇㅗㅣㄱㅜ, ㅇㅗㅣㄱㅜㄱ, ㄱㅏ, ㄱㅏㅂ, ㄱㅏㅂㅅ
		expect(multi.text).toBe('외 외국 국 값 ㅇ ㅇㄱ ㄱ ㅇㅗ ㅇㅗㅣ ㅇㅗㅣㄱ ㅇㅗㅣㄱㅜ ㅇㅗㅣㄱㅜㄱ ㄱㅏ ㄱㅏㅂ ㄱㅏㅂㅅ');
		expect(decomposeToJamo('의자')).toEqual(['ㅇ', 'ㅡ', 'ㅣ', 'ㅈ', 'ㅏ']);
		expect(extractChosung('닭갈비')).toBe('ㄷㄱㅂ');
	});

	it('splits filenames by delimiters and processes each word separately', () => {
		const stem = stripFileExtension('2026_한국-문서(최종).pdf');
		expect(stem).toBe('2026_한국-문서(최종)');
		expect(splitIntoWords(stem)).toEqual(['2026', '한국', '문서', '최종']);

		const result = generateSearchTokens('2026_한국-문서(최종).pdf');
		expect(result.effectiveLength).toBe(10);
		expect(result.mode).toBe('full');
		expect(result.tokens).toContain('2026');
		expect(result.tokens).toContain('한국');
		expect(result.tokens).toContain('문서');
		expect(result.tokens).toContain('최종');
		expect(result.tokens).toContain('ㅎㄱ');
		expect(result.tokens).toContain('ㅁㅅ');
		expect(result.tokens).toContain('ㅊㅈ');
		expect(result.tokens).toContain('ㅎㅏㄴㄱㅜㄱ');
		// Pure numeric token should not produce jamo/chosung beyond its own N-grams
		expect(result.tokens).toContain('20');
	});

	it('switches from full mode to ngram-only mode when effective length exceeds 10', () => {
		const tenChars = generateSearchTokens('대한민국경제보고서안.pdf');
		expect(DEFAULT_FULL_MODE_THRESHOLD).toBe(10);
		expect(tenChars.effectiveLength).toBe(10);
		expect(tenChars.mode).toBe('full');
		expect(tenChars.tokens).toContain('ㄷㅎㅁㄱㄱㅈㅂㄱㅅㅇ');
		expect(tenChars.tokens).toContain('ㄷㅐㅎㅏㄴㅁㅣㄴㄱㅜㄱㄱㅕㅇㅈㅔㅂㅗㄱㅗㅅㅓㅇㅏㄴ');

		const elevenChars = generateSearchTokens('대한민국경제보고서안건.pdf');
		expect(elevenChars.effectiveLength).toBe(11);
		expect(elevenChars.mode).toBe('ngram');
		expect(elevenChars.tokens).toContain('대한');
		expect(elevenChars.tokens).toContain('경제');
		expect(elevenChars.tokens).toContain('안건');
		expect(elevenChars.tokens).not.toContain('ㄷ');
		expect(elevenChars.tokens).not.toContain('ㄷㅐ');
	});

	it('splits search text > 1024 chars into caption and follow-up messages at token boundaries', () => {
		// 20 Hangul chars -> ngram mode produces 210 tokens (~1540 chars > 1024)
		const longResult = generateSearchTokens('가나다라마바사아자차카타파하거너더러머버.pdf');
		expect(longResult.mode).toBe('ngram');
		expect(longResult.text.length).toBeGreaterThan(TELEGRAM_CAPTION_LIMIT);

		const split = splitCaptionAndFollowUps(longResult.text);
		expect(Array.from(split.caption).length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
		expect(split.followUpMessages.length).toBeGreaterThan(0);
		for (const msg of split.followUpMessages) {
			expect(Array.from(msg).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
		}

		// Verify exact token preservation with zero split or lost tokens
		const reassembled = [split.caption, ...split.followUpMessages].join(' ').split(/\s+/);
		expect(reassembled).toEqual(longResult.tokens);
	});

	it('preserves original caption and puts overflow into follow-up messages', () => {
		const longResult = generateSearchTokens('가나다라마바사아자차카타파하거너더러머버.pdf');
		const originalCaption = '원본 설명입니다.';
		const split = splitCaptionAndFollowUps(longResult.text, originalCaption);

		expect(split.caption.startsWith(`${originalCaption}\n\n`)).toBe(true);
		expect(Array.from(split.caption).length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
		expect(split.followUpMessages.length).toBeGreaterThan(0);

		const captionTokens = split.caption.slice(`${originalCaption}\n\n`.length).trim().split(/\s+/);
		const followUpTokens = split.followUpMessages.join(' ').trim().split(/\s+/);
		expect([...captionTokens, ...followUpTokens]).toEqual(longResult.tokens);
	});

	it('preserves caption whitespace for entity offsets', () => {
		const original = ' \n 😀원본 설명  \n ';
		const split = splitCaptionAndFollowUps('한국 ㅎㄱ', original);
		expect(split.caption).toBe(`${original}\n\n한국 ㅎㄱ`);
		expect(split.preserveOriginal).toBe(false);
	});

	it('keeps a full caption and moves every token into replies', () => {
		const original = '가'.repeat(TELEGRAM_CAPTION_LIMIT);
		const split = splitCaptionAndFollowUps('한국 ㅎㄱ', original);
		expect(split.caption).toBe(original);
		expect(split.followUpMessages).toEqual(['한국 ㅎㄱ']);
		expect(split.preserveOriginal).toBe(false);
	});

	it('requires retaining an oversized original rather than truncating it', () => {
		const original = '가'.repeat(TELEGRAM_CAPTION_LIMIT) + '원본끝';
		const split = splitCaptionAndFollowUps('한국 ㅎㄱ', original);
		expect(split.preserveOriginal).toBe(true);
		expect(split.caption).toBe('');
		expect(split.followUpMessages).toEqual(['한국 ㅎㄱ']);
	});

	it('keeps the first tokens in the caption and two replies, omitting the rest', () => {
		const split = splitCaptionAndFollowUps('가 나 다 라 마 바 사 아 자 차 카 타', undefined, 5, 5);
		expect(split.caption).toBe('가 나 다');
		expect(split.followUpMessages).toEqual(['라 마 바', '사 아 자']);
	});

	it.each(['원본캡션유지', '원본캡션유지초과'])('limits replies while preserving the original caption: %s', (original) => {
		const split = splitCaptionAndFollowUps('가 나 다 라 마 바 사 아 자 차 카 타', original, 6, 5);
		expect(split.caption).toBe(original.length === 6 ? original : '');
		expect(split.preserveOriginal).toBe(original.length > 6);
		expect(split.followUpMessages).toEqual(['가 나 다', '라 마 바']);
	});

	it('keeps token order rather than skipping a longer token to include later ones', () => {
		const split = splitCaptionAndFollowUps('aaa bbbb cc ddd e f', undefined, 3, 4);
		expect(split.caption).toBe('aaa');
		expect(split.followUpMessages).toEqual(['bbbb', 'cc']);
	});

	it('caps oversized Unicode tokens without breaking surrogate pairs', () => {
		const split = splitCaptionAndFollowUps('😀'.repeat(15), undefined, 2, 3);
		expect(split.caption).toBe('');
		expect(split.followUpMessages).toEqual(['😀😀😀', '😀😀😀']);
	});

	it('stops generation at the output budget while preserving the original token prefix', () => {
		const stem = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(4);
		const allTokens = Array.from(new Set(generateWordNGrams(stem)));
		const result = generateSearchTokens(`${stem}.pdf`);
		expect(Array.from(result.text).length).toBeLessThanOrEqual(MAX_SEARCH_TEXT_LENGTH);
		expect(result.tokens.length).toBeLessThan(allTokens.length);
		expect(result.tokens).toEqual(allTokens.slice(0, result.tokens.length));
		expect(Array.from(`${result.text} ${allTokens[result.tokens.length]}`).length).toBeGreaterThan(MAX_SEARCH_TEXT_LENGTH);
		expect(splitCaptionAndFollowUps(result.text).followUpMessages).toHaveLength(2);
	});
});
