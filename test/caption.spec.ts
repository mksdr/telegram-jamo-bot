import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSearchTokens } from "../src/hangul";
import { processTelegramUpdate, type ProcessUpdateProgress, type TelegramMessage, type TelegramMessageEntity, type TelegramUpdate } from "../src/telegram";

function makeUpdate(patch: Partial<TelegramMessage> = {}): TelegramUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 50,
			chat: { id: -100123, type: "supergroup" },
			from: { id: 1, is_bot: false },
			document: { file_id: "test-file", file_name: "한국.pdf" },
			...patch,
		},
	};
}

function mockApi(failMedia = false) {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
		const method = String(input).split("/").pop()!;
		calls.push({ method, body: JSON.parse(String(init?.body)) });
		if (failMedia && method !== "sendMessage") return Response.json({ ok: false, error_code: 400 }, { status: 400 });
		return Response.json({ ok: true, result: method === "deleteMessage" ? true : { message_id: 200 } });
	});
	return { calls, fetchImpl };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("F05 original caption and entities", () => {
	it("preserves text links, mentions, emoji metadata and UTF-16 offsets", async () => {
		const caption = "  😀설명서 사용자 🧪\n ";
		const entities: TelegramMessageEntity[] = [
			{ type: "text_link", offset: 4, length: 3, url: "https://example.com/manual" },
			{ type: "text_mention", offset: caption.indexOf("사용자"), length: 3, user: { id: 42, is_bot: false, first_name: "사용자" } },
			{ type: "custom_emoji", offset: caption.indexOf("🧪"), length: 2, custom_emoji_id: "emoji-id" },
		];
		const update = makeUpdate({ caption, caption_entities: entities });
		const snapshot = structuredClone(update);
		const { calls, fetchImpl } = mockApi();
		const result = await processTelegramUpdate(update, { botToken: "test-token", fetchImpl });
		expect(result.deletedOriginal).toBe(true);
		expect(calls.map(c => c.method)).toEqual(["sendDocument", "deleteMessage"]);
		expect(calls[0].body.caption).toBe(`${caption}\n\n${generateSearchTokens("한국.pdf").text}`);
		expect(calls[0].body.caption_entities).toEqual(entities);
		expect(String(calls[0].body.caption).slice(4, 7)).toBe("설명서");
		expect(calls[0].body.parse_mode).toBeUndefined();
		expect(update).toEqual(snapshot);
	});

	it.each([
		{ type: "bold", offset: 0, length: 3 },
		{ type: "pre", offset: 0, length: 3, language: "python" },
		{ type: "future_entity", offset: 0, length: 3, future_metadata: { value: "keep" } },
	])("copies $type metadata without filtering fields", async entity => {
		const { calls, fetchImpl } = mockApi();
		await processTelegramUpdate(makeUpdate({ caption: "원본글", caption_entities: [entity] }), { botToken: "test-token", fetchImpl });
		expect(calls[0].body.caption_entities).toEqual([entity]);
	});

	it("keeps a maximum-length original caption and its final link intact", async () => {
		const caption = "가".repeat(1020) + "설명링크";
		const entity = { type: "text_link", offset: 1020, length: 4, url: "https://example.com/end" };
		const { calls, fetchImpl } = mockApi();
		const result = await processTelegramUpdate(makeUpdate({ caption, caption_entities: [entity] }), { botToken: "test-token", fetchImpl });
		expect(calls.map(c => c.method)).toEqual(["sendDocument", "sendMessage", "deleteMessage"]);
		expect(calls[0].body.caption).toBe(caption);
		expect(calls[0].body.caption_entities).toEqual([entity]);
		expect(calls[1].body.text).toBe(generateSearchTokens("한국.pdf").text);
		expect(result.deletedOriginal).toBe(true);
	});

	it("retains an oversized caption and a link crossing the caption limit at the source", async () => {
		const caption = "가".repeat(1100) + "원본끝표식";
		const entity = { type: "text_link", offset: 1000, length: 50, url: "https://example.com/crossing" };
		const update = makeUpdate({ caption, caption_entities: [entity], message_thread_id: 777 });
		const snapshot = structuredClone(update);
		const { calls, fetchImpl } = mockApi();
		const result = await processTelegramUpdate(update, { botToken: "test-token", fetchImpl });
		expect(result).toEqual({ handled: true, deletedOriginal: false, sentFollowUps: 1 });
		expect(calls.map(c => c.method)).toEqual(["sendMessage"]);
		expect(calls[0].body).toMatchObject({
			chat_id: -100123, message_thread_id: 777,
			text: generateSearchTokens("한국.pdf").text,
			reply_parameters: { message_id: 50 },
		});
		expect(update).toEqual(snapshot);
	});

	it.each([
		{ offset: -1, length: 1 },
		{ offset: 0, length: 100 },
		{ offset: 0, length: 0 },
		{ offset: 0, length: 1.5 },
		{ offset: 1, length: 1 }, // Splits the emoji's UTF-16 surrogate pair.
	])("retains the original if an entity range is unsafe: $offset/$length", async range => {
		const { calls, fetchImpl } = mockApi();
		const update = makeUpdate({ caption: "😀", caption_entities: [{ type: "bold", ...range }] });
		const result = await processTelegramUpdate(update, { botToken: "test-token", fetchImpl });
		expect(result.deletedOriginal).toBe(false);
		expect(calls.map(c => c.method)).toEqual(["sendMessage"]);
		expect(calls[0].body.reply_parameters).toMatchObject({ message_id: 50 });
	});

	it("does not delete the original when Telegram rejects caption entities", async () => {
		const { calls, fetchImpl } = mockApi(true);
		const result = await processTelegramUpdate(makeUpdate({
			caption: "설명서", caption_entities: [{ type: "text_link", offset: 0, length: 3, url: "https://example.com/manual" }],
		}), { botToken: "test-token", fetchImpl });
		expect(result).toMatchObject({ handled: false, reason: "resend_failed", needsReconciliation: true });
		expect(calls.map(c => c.method)).toEqual(["sendDocument"]);
	});

	it("holds a legacy partial job when its re-sent caption preservation cannot be proven", async () => {
		const { calls, fetchImpl } = mockApi();
		const progress: ProcessUpdateProgress = { resentMessageId: 200, sentFollowUps: 0 };
		const result = await processTelegramUpdate(makeUpdate({ caption: "  설명서  " }), { botToken: "test-token", fetchImpl, progress });
		expect(result).toMatchObject({ handled: false, reason: "caption_preservation_unverified", needsReconciliation: true });
		expect(calls).toEqual([]);
	});
});
