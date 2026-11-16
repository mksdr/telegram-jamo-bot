import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { processTelegramUpdate, type TelegramUpdate } from '../src/telegram';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function createBaseEnv(overrides: Partial<Env> = {}): Env {
	return {
		...env,
		TELEGRAM_BOT_TOKEN: 'test-bot-token',
		TELEGRAM_WEBHOOK_SECRET: 'test-secret',
		FULL_MODE_THRESHOLD: '10',
		...overrides,
	};
}

describe('Telegram Jamo Bot Worker', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('responds to GET / health check', async () => {
		const request = new IncomingRequest('https://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, createBaseEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Telegram Jamo Bot is running.');
	});

	it('rejects webhook requests with missing or invalid secret token', async () => {
		const update: TelegramUpdate = { update_id: 1 };
		const request = new IncomingRequest('https://example.com/webhook', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
			},
			body: JSON.stringify(update),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, createBaseEnv(), ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it('handles private chat document upload, resends with generated caption, and deletes original', async () => {
		const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = url.split('/').pop() ?? '';
			const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			calls.push({ method, body });

			if (method === 'sendDocument') {
				return Response.json({ ok: true, result: { message_id: 200, chat: { id: 10, type: 'private' } } });
			}
			if (method === 'deleteMessage') {
				return Response.json({ ok: true, result: true });
			}
			return Response.json({ ok: false });
		});

		const update: TelegramUpdate = {
			update_id: 100,
			message: {
				message_id: 50,
				from: { id: 1, is_bot: false },
				chat: { id: 10, type: 'private' },
				document: { file_id: 'doc-file-id-1', file_name: '한국.pdf' },
			},
		};

		const request = new IncomingRequest('https://example.com/webhook', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Telegram-Bot-Api-Secret-Token': 'test-secret',
			},
			body: JSON.stringify(update),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, createBaseEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({
			method: 'sendDocument',
			body: {
				chat_id: 10,
				document: 'doc-file-id-1',
				caption: '한 한국 국 ㅎ ㅎㄱ ㅎㅏ ㅎㅏㄴ ㅎㅏㄴㄱ ㅎㅏㄴㄱㅜ ㅎㅏㄴㄱㅜㄱ',
			},
		});
		expect(calls[1]).toEqual({
			method: 'deleteMessage',
			body: {
				chat_id: 10,
				message_id: 50,
			},
		});
	});

	it('handles supergroup forum topics and channel_post updates', async () => {
		const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = url.split('/').pop() ?? '';
			const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			calls.push({ method, body });
			return Response.json({ ok: true, result: { message_id: 999 } });
		});

		// Supergroup with message_thread_id
		const groupRes = await processTelegramUpdate(
			{
				update_id: 101,
				message: {
					message_id: 51,
					message_thread_id: 777,
					from: { id: 2, is_bot: false },
					chat: { id: -10012345, type: 'supergroup' },
					video: { file_id: 'vid-1', file_name: '과.mp4' },
				},
			},
			{ botToken: 'token', fetchImpl: mockFetch },
		);
		expect(groupRes).toEqual({ handled: true, deletedOriginal: true, sentFollowUps: 0 });
		expect(calls[0]).toEqual({
			method: 'sendVideo',
			body: {
				chat_id: -10012345,
				video: 'vid-1',
				caption: '과 ㄱ ㄱㅗ ㄱㅗㅏ',
				message_thread_id: 777,
			},
		});

		calls.length = 0;

		// Channel post (no `from` field)
		const channelRes = await processTelegramUpdate(
			{
				update_id: 102,
				channel_post: {
					message_id: 52,
					chat: { id: -10099999, type: 'channel' },
					document: { file_id: 'chan-doc-1', file_name: '닭.pdf' },
				},
			},
			{ botToken: 'token', fetchImpl: mockFetch },
		);
		expect(channelRes).toEqual({ handled: true, deletedOriginal: true, sentFollowUps: 0 });
		expect(calls[0]).toEqual({
			method: 'sendDocument',
			body: {
				chat_id: -10099999,
				document: 'chan-doc-1',
				caption: '닭 ㄷ ㄷㅏ ㄷㅏㄹ ㄷㅏㄹㄱ',
			},
		});
		expect(calls[1]).toEqual({
			method: 'deleteMessage',
			body: {
				chat_id: -10099999,
				message_id: 52,
			},
		});
	});

	it('handles missing delete permission gracefully without throwing', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const mockFetch = vi.fn<typeof fetch>(async (input) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = url.split('/').pop() ?? '';
			if (method === 'sendDocument') {
				return Response.json({ ok: true, result: { message_id: 301 } });
			}
			if (method === 'deleteMessage') {
				return Response.json({
					ok: false,
					error_code: 400,
					description: "Bad Request: message can't be deleted",
				});
			}
			return Response.json({ ok: false });
		});

		const result = await processTelegramUpdate(
			{
				update_id: 103,
				message: {
					message_id: 60,
					from: { id: 3, is_bot: false },
					chat: { id: -100111, type: 'group' },
					document: { file_id: 'doc-2', file_name: '한국.pdf' },
				},
			},
			{ botToken: 'token', fetchImpl: mockFetch },
		);

		expect(result).toEqual({
			handled: true,
			deletedOriginal: false,
			sentFollowUps: 0,
		});
	});

	it('does not delete original file when bot lacks send permission', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const calls: string[] = [];
		const mockFetch = vi.fn<typeof fetch>(async (input) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = url.split('/').pop() ?? '';
			calls.push(method);
			return Response.json({
				ok: false,
				error_code: 403,
				description: 'Forbidden: not enough rights to send documents to the chat',
			});
		});

		const result = await processTelegramUpdate(
			{
				update_id: 104,
				message: {
					message_id: 61,
					from: { id: 4, is_bot: false },
					chat: { id: -100222, type: 'channel' },
					document: { file_id: 'doc-3', file_name: '한국.pdf' },
				},
			},
			{ botToken: 'token', fetchImpl: mockFetch },
		);

		expect(result).toEqual({ handled: false, reason: 'resend_failed', needsReconciliation: true });
		expect(calls).toEqual(['sendDocument']);
	});

	it('sends overflow tokens as reply messages when search text exceeds 1024 chars', async () => {
		const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
		const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const method = url.split('/').pop() ?? '';
			const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			calls.push({ method, body });

			if (method === 'sendDocument') {
				return Response.json({ ok: true, result: { message_id: 888 } });
			}
			if (method === 'sendMessage') {
				return Response.json({ ok: true, result: { message_id: 889 } });
			}
			return Response.json({ ok: true, result: true });
		});

		const result = await processTelegramUpdate(
			{
				update_id: 105,
				message: {
					message_id: 62,
					from: { id: 5, is_bot: false },
					chat: { id: 99, type: 'private' },
					document: {
						file_id: 'long-doc-1',
						file_name: '가나다라마바사아자차카타파하거너더러머버.pdf',
					},
				},
			},
			{ botToken: 'token', fetchImpl: mockFetch },
		);

		expect(result.handled).toBe(true);
		expect(result.deletedOriginal).toBe(true);
		expect(result.sentFollowUps).toBeGreaterThan(0);
		expect(calls[0].method).toBe('sendDocument');
		expect(String(calls[0].body.caption).length).toBeLessThanOrEqual(1024);
		expect(calls[1].method).toBe('sendMessage');
		expect(calls[1].body.reply_parameters).toEqual({
			message_id: 888,
			allow_sending_without_reply: true,
		});
		expect(calls[calls.length - 1].method).toBe('deleteMessage');
	});

	it('ignores messages sent by bots to prevent infinite loops', async () => {
		const mockFetch = vi.fn<typeof fetch>();
		const result = await processTelegramUpdate(
			{
				update_id: 106,
				message: {
					message_id: 63,
					from: { id: 999, is_bot: true },
					chat: { id: 10, type: 'private' },
					document: { file_id: 'bot-doc', file_name: '한국.pdf' },
				},
			},
			{ botToken: 'token', fetchImpl: mockFetch },
		);

		expect(result).toEqual({ handled: false, reason: 'from_bot' });
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
