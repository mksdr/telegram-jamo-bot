import { env } from "cloudflare:workers";
import { createExecutionContext, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { callTelegramApi, processTelegramUpdate, TELEGRAM_API_TIMEOUT_MS, UPDATE_TIME_BUDGET_MS, type ProcessUpdateProgress, type ProcessUpdateResult, type TelegramUpdate } from "../src/telegram";

let nextId = 1_000;
const token = "123456:test-token";
const secret = "test-secret";
const baseEnv = (): Env => ({ ...env, TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret });
const makeUpdate = (long = false): TelegramUpdate => ({
	update_id: nextId++,
	message: {
		message_id: 50,
		chat: { id: -100123, type: "supergroup" },
		from: { id: 1, is_bot: false },
		document: { file_id: "test-file", file_name: long ? "가나다라마바사아자차카타파하거너더러머버.pdf" : "한국.pdf" },
	},
});
const stubFor = (update: TelegramUpdate) => env.TELEGRAM_UPDATES.getByName(`123456:${update.update_id}`);
function post(update: TelegramUpdate, overrides: Partial<Env> = {}, header: string | null = secret, pathname = "/webhook") {
	return worker.fetch(new Request(`https://example.com${pathname}`, {
		method: "POST",
		headers: header === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": header },
		body: JSON.stringify(update),
	}), { ...baseEnv(), ...overrides }, createExecutionContext());
}
function methodOf(input: Parameters<typeof fetch>[0]) {
	return (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).split("/").pop();
}
function mockSuccess() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async input => Response.json({
		ok: true, result: methodOf(input) === "deleteMessage" ? true : { message_id: 200 },
	}));
}
async function clearCooldown(update: TelegramUpdate) {
	await runInDurableObject(stubFor(update), async (_, state) => {
		const record = await state.storage.get<{ progress: ProcessUpdateProgress }>("update");
		expect(record).toBeDefined();
		record!.progress.retryAt = Date.now() - 1;
		await state.storage.put("update", record);
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("F01 webhook authentication", () => {
	it.each([undefined, "", "   "])("fails closed for missing/empty secret (%s)", async value => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const outbound = mockSuccess();
		// Missing config is checked before parsing an invalid body on both webhook aliases.
		for (const pathname of ["/", "/webhook"]) {
			const request = new Request(`https://example.com${pathname}`, { method: "POST", body: "not-json" });
			const response = await worker.fetch(request, { ...baseEnv(), TELEGRAM_WEBHOOK_SECRET: value }, createExecutionContext());
			expect(response.status).toBe(503);
		}
		expect(outbound).not.toHaveBeenCalled();
	});
	it.each([null, "wrong-secret"])("rejects missing/incorrect header (%s)", async header => {
		const outbound = mockSuccess();
		expect((await post(makeUpdate(), {}, header)).status).toBe(401);
		expect(outbound).not.toHaveBeenCalled();
	});
	it("retains health checks without configured secrets", async () => {
		const response = await worker.fetch(new Request("https://example.com/health"), { ...env }, createExecutionContext());
		expect(response.status).toBe(200);
	});
	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid journal ID %s", async update_id => {
		const outbound = mockSuccess();
		expect((await post({ update_id })).status).toBe(400);
		expect(outbound).not.toHaveBeenCalled();
	});
});

describe("F03 durable webhook processing", () => {
	it("does not acknowledge until the last API call and durable completion", async () => {
		const update = makeUpdate();
		let finish!: (response: Response) => void;
		let deletionStarted!: () => void;
		const started = new Promise<void>(resolve => { deletionStarted = resolve; });
		vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
			if (methodOf(input) === "deleteMessage") {
				deletionStarted();
				return new Promise<Response>(resolve => { finish = resolve; });
			}
			return Response.json({ ok: true, result: { message_id: 200 } });
		});
		let settled = false;
		const response = post(update).then(value => { settled = true; return value; });
		await started;
		expect(settled).toBe(false);
		finish(Response.json({ ok: true, result: true }));
		expect((await response).status).toBe(200);
		const saved = await runInDurableObject(stubFor(update), (_, state) => state.storage.get<{ result: ProcessUpdateResult }>("update"));
		expect(saved?.result.handled).toBe(true);
	});
	it("coalesces concurrent requests and remembers completion after eviction", async () => {
		const update = makeUpdate();
		const outbound = mockSuccess();
		const responses = await Promise.all([post(update), post(update)]);
		expect(responses.map(r => r.status)).toEqual([200, 200]);
		expect(outbound).toHaveBeenCalledTimes(2);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(200);
		expect(outbound).toHaveBeenCalledTimes(2);
	});
	it("returns 503 for 429, honors its cooldown, then resumes after eviction", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess().mockImplementationOnce(async () => Response.json({
			ok: false, error_code: 429, parameters: { retry_after: 60 },
		}, { status: 429 }));
		const first = await post(update);
		expect(first.status).toBe(503);
		expect(first.headers.get("Retry-After")).toBe("60");
		expect((await post(update)).status).toBe(503);
		expect(outbound).toHaveBeenCalledTimes(1);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "sendDocument", "deleteMessage"]);
	});
	it.each([400, 401, 403, 404])("holds a rejected media send (%s) across cooldowns and eviction", async errorCode => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		update.message!.caption = "설명서";
		update.message!.caption_entities = [{ type: "text_link", offset: 0, length: 3, url: "https://example.com/manual" }];
		const outbound = mockSuccess().mockImplementationOnce(async () => Response.json({ ok: false, error_code: errorCode }, { status: errorCode }));
		expect((await post(update)).status).toBe(503);
		const saved = await runInDurableObject(stubFor(update), (_, state) => state.storage.get<{ progress: ProcessUpdateProgress; lastFailure: ProcessUpdateResult }>("update"));
		expect(saved?.progress.blockedSend).toEqual({ reason: "resend_failed", errorCode });
		expect(saved?.progress.pendingSend).toBeUndefined();
		expect(saved?.progress.retryAt).toBeUndefined();
		expect(saved?.lastFailure.needsReconciliation).toBe(true);
		expect((await post(update)).status).toBe(503);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(503);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument"]);
		expect(await runDurableObjectAlarm(stubFor(update))).toBe(false);
	});
	it.each([400, 403])("holds a rejected follow-up (%s) without further sends or deletion", async errorCode => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate(true);
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 201 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false, error_code: errorCode }, { status: errorCode }));
		expect((await post(update)).status).toBe(503);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(503);
		const saved = await runInDurableObject(stubFor(update), (_, state) => state.storage.get<{ progress: ProcessUpdateProgress; lastFailure: ProcessUpdateResult }>("update"));
		expect(saved?.progress).toMatchObject({ resentMessageId: 201, sentFollowUps: 0, blockedSend: { reason: "follow_up_failed", errorCode } });
		expect(saved?.lastFailure.needsReconciliation).toBe(true);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "sendMessage"]);
	});
	it("keeps a send rejection blocked when the final failure journal write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess().mockImplementationOnce(async () => Response.json({ ok: false, error_code: 400 }, { status: 400 }));
		await runInDurableObject(stubFor(update), (_, state) => {
			const put = state.storage.put.bind(state.storage);
			vi.spyOn(state.storage, "put")
				.mockImplementationOnce(put).mockImplementationOnce(put).mockImplementationOnce(put)
				.mockRejectedValueOnce(new Error("final journal write unavailable"));
		});
		expect((await post(update)).status).toBe(503);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(503);
		expect(outbound).toHaveBeenCalledTimes(1);
	});
	it.each([400, 403])("still completes after a definite deletion rejection (%s)", async errorCode => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 201 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false, error_code: errorCode }, { status: errorCode }));
		expect((await post(makeUpdate())).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "deleteMessage"]);
	});
	it.each([408, 500])("retries a transient media rejection (%s) after cooldown and eviction", async errorCode => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess().mockImplementationOnce(async () => Response.json({ ok: false, error_code: errorCode }, { status: errorCode }));
		expect((await post(update)).status).toBe(503);
		expect((await post(update)).status).toBe(503);
		expect(outbound).toHaveBeenCalledTimes(1);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "sendDocument", "deleteMessage"]);
	});
	it("resumes a failed follow-up without resending the file or deleting early", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate(true);
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 201 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false, error_code: 500 }, { status: 500 }));
		expect((await post(update)).status).toBe(503);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "sendMessage"]);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "sendMessage", "sendMessage", "deleteMessage"]);
	});
	it("keeps successful follow-up checkpoints when a later chunk fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		update.message!.document!.file_name = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0xac00 + i)).join("") + ".pdf";
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 201 } }))
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 202 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 10 } }, { status: 429 }));
		expect((await post(update)).status).toBe(503);
		const firstChunk = JSON.parse(String(outbound.mock.calls[1][1]?.body)).text;
		await clearCooldown(update);
		expect((await post(update)).status).toBe(200);
		const followUps = outbound.mock.calls.filter(([input]) => methodOf(input) === "sendMessage");
		expect(followUps).toHaveLength(4); // 3 distinct chunks, one rejected attempt.
		expect(followUps.filter(([, init]) => JSON.parse(String(init?.body)).text === firstChunk)).toHaveLength(1);
	});
	it("retries transient deletion without repeating successful sends", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 200 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false, error_code: 500 }, { status: 500 }));
		expect((await post(update)).status).toBe(503);
		await clearCooldown(update);
		expect((await post(update)).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "deleteMessage", "deleteMessage"]);
	});
	it("does not acknowledge a deletion server error without a JSON error_code", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 200 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false }, { status: 502 }));
		expect((await post(update)).status).toBe(503);
		await clearCooldown(update);
		expect((await post(update)).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "deleteMessage", "deleteMessage"]);
	});
	it("retains ambiguous delivery instead of resending after a network failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess().mockRejectedValueOnce(new Error(`network error containing ${token}`));
		expect((await post(update)).status).toBe(503);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(503);
		expect(outbound).toHaveBeenCalledTimes(1);
		const saved = await runInDurableObject(stubFor(update), (_, state) => state.storage.get<{ progress: ProcessUpdateProgress; lastFailure: ProcessUpdateResult }>("update"));
		expect(saved?.progress.pendingSend).toBe("media");
		expect(saved?.lastFailure.needsReconciliation).toBe(true);
		expect(JSON.stringify(saved)).not.toContain(token);
	});
	it("does not acknowledge or repeat a send with an invalid success result", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess().mockImplementationOnce(async () => Response.json({ ok: true }));
		expect((await post(update)).status).toBe(503);
		expect((await post(update)).status).toBe(503);
		expect(outbound).toHaveBeenCalledTimes(1);
	});
	it("does not send when the first durable checkpoint fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess();
		await runInDurableObject(stubFor(update), (_, state) => {
			vi.spyOn(state.storage, "put").mockRejectedValueOnce(new Error("storage unavailable"));
		});
		expect((await post(update)).status).toBe(503);
		expect(outbound).not.toHaveBeenCalled();
		expect((await post(update)).status).toBe(200);
	});
	it("does not resend if recording a successful send fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		const outbound = mockSuccess();
		await runInDurableObject(stubFor(update), (_, state) => {
			const put = state.storage.put.bind(state.storage);
			vi.spyOn(state.storage, "put")
				.mockImplementationOnce(put).mockImplementationOnce(put)
				.mockRejectedValueOnce(new Error("checkpoint unavailable"));
		});
		expect((await post(update)).status).toBe(503);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(503);
		expect(outbound).toHaveBeenCalledTimes(1);
	});
	it("ignores unsupported updates successfully", async () => {
		const outbound = mockSuccess();
		expect((await post({ update_id: nextId++ })).status).toBe(200);
		expect(outbound).not.toHaveBeenCalled();
	});
	it("cleans completed journals after retention while keeping unresolved work", async () => {
		const update = makeUpdate();
		mockSuccess();
		await post(update);
		expect(await runDurableObjectAlarm(stubFor(update))).toBe(true);
		expect(await runInDurableObject(stubFor(update), (_, state) => state.storage.get("update"))).toBeUndefined();
		const unresolved = makeUpdate();
		await runInDurableObject(stubFor(unresolved), async (_, state) => {
			await state.storage.put("update", { update: unresolved, threshold: 10, progress: { sentFollowUps: 0, pendingSend: "media" } });
			await state.storage.setAlarm(Date.now() + 1000);
		});
		await runDurableObjectAlarm(stubFor(unresolved));
		expect(await runInDurableObject(stubFor(unresolved), (_, state) => state.storage.get("update"))).toBeDefined();
	});
});

describe("F04 duplicate update protection", () => {
	it("does not repeat media, follow-ups or deletion on sequential webhook aliases", async () => {
		const update = makeUpdate(true);
		const outbound = mockSuccess();
		expect((await post(update)).status).toBe(200);
		const confirmedCalls = outbound.mock.calls.length;
		expect(confirmedCalls).toBeGreaterThan(2);
		expect((await post(update, {}, secret, "/")).status).toBe(200);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(200);
		expect(outbound).toHaveBeenCalledTimes(confirmedCalls);
	});
	it("shares a processing attempt even while an external API call is suspended", async () => {
		const update = makeUpdate();
		let release!: (response: Response) => void;
		let notifyStarted!: () => void;
		const started = new Promise<void>(resolve => { notifyStarted = resolve; });
		const outbound = mockSuccess().mockImplementationOnce(async () => {
			notifyStarted();
			return new Promise<Response>(resolve => { release = resolve; });
		});
		const results = await runInDurableObject(stubFor(update), async instance => {
			const first = instance.process(update, token, 10);
			await started;
			const duplicates = Array.from({ length: 4 }, () => instance.process(update, token, 10));
			expect(outbound).toHaveBeenCalledTimes(1);
			release(Response.json({ ok: true, result: { message_id: 200 } }));
			return Promise.all([first, ...duplicates]);
		});
		expect(results.every(r => r.handled)).toBe(true);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "deleteMessage"]);
	});
	it("pins the original payload and threshold across partial-job retries", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate(true);
		update.message!.caption = "  설명서  ";
		update.message!.caption_entities = [{ type: "text_link", offset: 2, length: 3, url: "https://example.com/manual" }];
		const outbound = mockSuccess()
			.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 201 } }))
			.mockImplementationOnce(async () => Response.json({ ok: false, error_code: 500 }, { status: 500 }));
		expect((await post(update)).status).toBe(503);
		const failedReply = JSON.parse(String(outbound.mock.calls[1][1]?.body));
		const changed = structuredClone(update);
		changed.message!.chat.id = -100999;
		changed.message!.message_id = 999;
		changed.message!.caption = "changed";
		changed.message!.document!.file_name = "다른파일.pdf";
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(changed, { FULL_MODE_THRESHOLD: "1000" })).status).toBe(200);
		expect(JSON.parse(String(outbound.mock.calls[2][1]?.body))).toEqual(failedReply);
		const deletes = outbound.mock.calls.filter(([input]) => methodOf(input) === "deleteMessage");
		expect(deletes).toHaveLength(1);
		expect(JSON.parse(String(deletes[0][1]?.body))).toEqual({ chat_id: -100123, message_id: 50 });
		expect(outbound.mock.calls.filter(([input]) => methodOf(input) === "sendDocument")).toHaveLength(1);
	});
	it("isolates bot identities and distinct updates", async () => {
		const first = makeUpdate();
		const second = makeUpdate();
		second.message!.message_id = 51;
		const outbound = mockSuccess();
		for (const update of [first, second]) expect((await post(update)).status).toBe(200);
		expect((await post(first, { TELEGRAM_BOT_TOKEN: "654321:other-token" })).status).toBe(200);
		expect(outbound.mock.calls.filter(([input]) => methodOf(input) === "sendDocument")).toHaveLength(3);
	});
});

describe("F05 caption preservation across durable retries", () => {
	it("retains oversized source captions through failure, eviction and duplicate delivery", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const update = makeUpdate();
		update.message!.caption = "가".repeat(1100) + "원본끝";
		update.message!.caption_entities = [{ type: "text_link", offset: 1000, length: 50, url: "https://example.com/manual" }];
		const outbound = mockSuccess().mockImplementationOnce(async () => Response.json({ ok: false, error_code: 500 }, { status: 500 }));
		expect((await post(update)).status).toBe(503);
		await clearCooldown(update);
		await evictDurableObject(stubFor(update));
		expect((await post(update)).status).toBe(200);
		expect((await post(update)).status).toBe(200);
		expect(outbound.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendMessage", "sendMessage"]);
		for (const [, init] of outbound.mock.calls) {
			expect(JSON.parse(String(init?.body)).reply_parameters.message_id).toBe(50);
		}
	});
});

describe("bounded Telegram API calls", () => {
	it("yields at the update time budget and resumes confirmed steps", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(0));
		const progress: ProcessUpdateProgress = { sentFollowUps: 0 };
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			vi.setSystemTime(new Date(UPDATE_TIME_BUDGET_MS));
			return Response.json({ ok: true, result: { message_id: 200 } });
		});
		const update = makeUpdate();
		const first = await processTelegramUpdate(update, { botToken: token, fetchImpl, progress });
		expect(first).toMatchObject({ handled: false, reason: "time_budget_exceeded" });
		expect(fetchImpl.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument"]);
		const result = await processTelegramUpdate(update, { botToken: token, fetchImpl, progress });
		expect(result.handled).toBe(true);
		expect(fetchImpl.mock.calls.map(([input]) => methodOf(input))).toEqual(["sendDocument", "deleteMessage"]);
	});
	it("aborts a hung request and does not expose the bot token", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const mockFetch = vi.fn<typeof fetch>(async (_, init) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		});
		const pending = callTelegramApi(token, "sendDocument", {}, mockFetch);
		await vi.advanceTimersByTimeAsync(TELEGRAM_API_TIMEOUT_MS);
		const result = await pending;
		expect(signal?.aborted).toBe(true);
		expect(result).toMatchObject({ ok: false, uncertain: true });
		expect(result.description).not.toContain(token);
	});
	it("also bounds response body parsing", async () => {
		vi.useFakeTimers();
		const body = new ReadableStream();
		const mockFetch = vi.fn<typeof fetch>(async () => new Response(body));
		const pending = callTelegramApi(token, "sendDocument", {}, mockFetch);
		await vi.advanceTimersByTimeAsync(TELEGRAM_API_TIMEOUT_MS);
		expect(await pending).toMatchObject({ ok: false, uncertain: true });
	});
	it("marks invalid success payloads as uncertain", async () => {
		const mockFetch = vi.fn<typeof fetch>(async () => new Response("not-json"));
		expect(await callTelegramApi(token, "sendDocument", {}, mockFetch)).toMatchObject({ ok: false, uncertain: true });
	});
});
