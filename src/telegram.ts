import { generateSearchTokens, getFileNameWords, splitCaptionAndFollowUps } from './hangul';

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type?: 'private' | 'group' | 'supergroup' | 'channel';
}

export interface TelegramFileAttachment {
	file_id: string;
	file_unique_id?: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

/** Offsets and lengths use UTF-16 code units, as defined by the Bot API. */
export interface TelegramMessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	user?: TelegramUser;
	language?: string;
	custom_emoji_id?: string;
	// Preserve metadata on new entity types rather than silently dropping it.
	[key: string]: unknown;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	from?: TelegramUser;
	chat: TelegramChat;
	caption?: string;
	caption_entities?: TelegramMessageEntity[];
	text?: string;
	document?: TelegramFileAttachment;
	audio?: TelegramFileAttachment & { title?: string; performer?: string };
	video?: TelegramFileAttachment;
	animation?: TelegramFileAttachment;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	channel_post?: TelegramMessage;
}

export type SupportedMediaKind = 'document' | 'audio' | 'video' | 'animation';

export interface TargetMedia {
	kind: SupportedMediaKind;
	fileId: string;
	fileName: string;
}

export interface TelegramApiResponse<T = unknown> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: { retry_after?: number };
	/** The remote send may have succeeded; retrying it could duplicate a message. */
	uncertain?: boolean;
}

export interface ProcessUpdateOptions {
	botToken: string;
	threshold?: number;
	fetchImpl?: typeof fetch;
	progress?: ProcessUpdateProgress;
	saveProgress?: (progress: ProcessUpdateProgress) => Promise<void>;
}

export interface ProcessUpdateProgress {
	resentMessageId?: number;
	/** The confirmed re-send used the lossless caption/entity policy. */
	captionPreserved?: boolean;
	sentFollowUps: number;
	pendingSend?: 'media' | 'follow_up';
	/** A definite non-retryable send rejection, retained for operator reconciliation. */
	blockedSend?: { reason: string; errorCode: number };
	retryAt?: number;
}

export interface ProcessUpdateResult {
	handled: boolean;
	reason?: string;
	deletedOriginal?: boolean;
	sentFollowUps?: number;
	retryAfter?: number;
	needsReconciliation?: boolean;
}

export const TELEGRAM_API_TIMEOUT_MS = 5_000;
export const UPDATE_TIME_BUDGET_MS = 20_000;

const IGNORED_REASONS = new Set(['no_message', 'from_bot', 'no_supported_file', 'empty_tokens', 'chat_not_allowed']);

export function isUpdateComplete(result: ProcessUpdateResult): boolean {
	return result.handled || (result.reason !== undefined && IGNORED_REASONS.has(result.reason));
}

function canPreserveCaptionEntities(caption: string, entities: unknown): boolean {
	if (entities === undefined) return true;
	if (!Array.isArray(entities)) return false;
	const isBoundary = (index: number) =>
		!(
			index > 0 &&
			index < caption.length &&
			caption.charCodeAt(index - 1) >= 0xd800 &&
			caption.charCodeAt(index - 1) <= 0xdbff &&
			caption.charCodeAt(index) >= 0xdc00 &&
			caption.charCodeAt(index) <= 0xdfff
		);
	return entities.every(
		(entity) =>
			entity &&
			typeof entity === 'object' &&
			typeof entity.type === 'string' &&
			Number.isSafeInteger(entity.offset) &&
			Number.isSafeInteger(entity.length) &&
			entity.offset >= 0 &&
			entity.length > 0 &&
			entity.offset + entity.length <= caption.length &&
			isBoundary(entity.offset) &&
			isBoundary(entity.offset + entity.length),
	);
}

const SEND_METHOD_BY_KIND: Record<SupportedMediaKind, string> = {
	document: 'sendDocument',
	audio: 'sendAudio',
	video: 'sendVideo',
	animation: 'sendAnimation',
};

/**
 * Extracts a supported file attachment and its filename from a Telegram message.
 */
export function extractTargetMedia(message: TelegramMessage): TargetMedia | null {
	const candidates: Array<{
		kind: SupportedMediaKind;
		attachment?: TelegramFileAttachment & { title?: string };
	}> = [
		{ kind: 'document', attachment: message.document },
		{ kind: 'audio', attachment: message.audio },
		{ kind: 'video', attachment: message.video },
		{ kind: 'animation', attachment: message.animation },
	];

	for (const { kind, attachment } of candidates) {
		if (!attachment?.file_id) continue;
		const rawName = attachment.file_name?.trim() || (kind === 'audio' ? attachment.title?.trim() : undefined);
		if (rawName) {
			return {
				kind,
				fileId: attachment.file_id,
				fileName: rawName,
			};
		}
	}

	return null;
}

export function classifyTelegramUpdate(
	update: TelegramUpdate,
): { message: TelegramMessage; media: TargetMedia } | { handled: false; reason: string } {
	const message = update.message ?? update.channel_post;
	if (!message) return { handled: false, reason: 'no_message' };
	if (message.from?.is_bot) return { handled: false, reason: 'from_bot' };
	const media = extractTargetMedia(message);
	if (!media) return { handled: false, reason: 'no_supported_file' };
	// A nonempty word always yields at least its first character as a token.
	if (getFileNameWords(media.fileName).length === 0) return { handled: false, reason: 'empty_tokens' };
	return { message, media };
}

/**
 * Calls a Telegram Bot API method safely, catching network and JSON parsing errors.
 */
export async function callTelegramApi<T = unknown>(
	botToken: string,
	method: string,
	payload: Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = TELEGRAM_API_TIMEOUT_MS,
): Promise<TelegramApiResponse<T>> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
					signal: controller.signal,
				});
				const data = (await response.json()) as TelegramApiResponse<T>;
				if (!data || typeof data.ok !== 'boolean' || (!response.ok && data.ok)) {
					return { ok: false, uncertain: true, description: 'Unexpected Telegram API response' };
				}
				if (!data.ok && typeof data.error_code !== 'number') {
					return { ...data, error_code: response.status };
				}
				return data;
			})(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					controller.abort();
					reject(new Error('Telegram API request timed out'));
				}, timeoutMs);
			}),
		]);
	} catch {
		return {
			ok: false,
			uncertain: true,
			description: `Telegram API request failed for ${method}`,
		};
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

/**
 * Resumes confirmed steps from a checkpoint. Persist send intent before making an
 * external call, so a crash or lost API response cannot silently duplicate it.
 */
export async function processTelegramUpdate(update: TelegramUpdate, options: ProcessUpdateOptions): Promise<ProcessUpdateResult> {
	const progress = options.progress ?? { sentFollowUps: 0 };
	const save = async () => {
		await options.saveProgress?.(progress);
	};
	if (progress.blockedSend) {
		return { handled: false, reason: progress.blockedSend.reason, needsReconciliation: true };
	}
	if (progress.pendingSend) {
		return { handled: false, reason: 'delivery_uncertain', needsReconciliation: true };
	}
	if (progress.retryAt && progress.retryAt > Date.now()) {
		return { handled: false, reason: 'retry_later', retryAfter: Math.ceil((progress.retryAt - Date.now()) / 1000) };
	}
	const classified = classifyTelegramUpdate(update);
	if ('reason' in classified) return classified;
	const { message: msg, media } = classified;
	const deadline = Date.now() + UPDATE_TIME_BUDGET_MS;
	const request = async <T>(method: string, payload: Record<string, unknown>) =>
		callTelegramApi<T>(
			options.botToken,
			method,
			payload,
			options.fetchImpl ?? fetch,
			Math.max(1, Math.min(TELEGRAM_API_TIMEOUT_MS, deadline - Date.now())),
		);
	const failed = async (reason: string, response: TelegramApiResponse): Promise<ProcessUpdateResult> => {
		if (response.uncertain && progress.pendingSend) {
			// Keep the intent for reconciliation; never automatically repeat an ambiguous send.
			await save();
			return { handled: false, reason: 'delivery_uncertain', needsReconciliation: true };
		}
		const errorCode = response.error_code;
		if (
			progress.pendingSend &&
			!response.uncertain &&
			errorCode !== undefined &&
			errorCode >= 400 &&
			errorCode < 500 &&
			errorCode !== 408 &&
			errorCode !== 429
		) {
			// Persist the rejection in the checkpoint, not just the final failure result.
			// A restart or a failed final journal write must not repeat this send.
			progress.blockedSend = { reason, errorCode };
			delete progress.pendingSend;
			delete progress.retryAt;
			await save();
			return { handled: false, reason, needsReconciliation: true };
		}
		delete progress.pendingSend;
		const requestedDelay = response.parameters?.retry_after;
		const retryAfter =
			typeof requestedDelay === 'number' && Number.isSafeInteger(requestedDelay) && requestedDelay > 0 ? requestedDelay : undefined;
		progress.retryAt = Date.now() + (retryAfter ?? 1) * 1000;
		await save();
		return { handled: false, reason, ...(retryAfter !== undefined ? { retryAfter } : {}) };
	};
	const budgetExceeded = () => Date.now() >= deadline;
	const { text } = generateSearchTokens(media.fileName, options.threshold);
	const split = splitCaptionAndFollowUps(text, msg.caption);
	const preserveOriginal = split.preserveOriginal || !canPreserveCaptionEntities(msg.caption ?? '', msg.caption_entities);
	const { caption, followUpMessages } = preserveOriginal ? splitCaptionAndFollowUps(text, undefined, 0) : split;
	const topic = msg.message_thread_id !== undefined ? { message_thread_id: msg.message_thread_id } : {};

	if (
		progress.resentMessageId !== undefined &&
		!progress.captionPreserved &&
		((msg.caption?.length ?? 0) > 0 || (msg.caption_entities?.length ?? 0) > 0)
	) {
		// A journal from the previous caption policy cannot prove that metadata survived.
		return { handled: false, reason: 'caption_preservation_unverified', needsReconciliation: true };
	}
	if (!preserveOriginal && progress.resentMessageId === undefined) {
		if (budgetExceeded()) return { handled: false, reason: 'time_budget_exceeded', retryAfter: 1 };
		progress.pendingSend = 'media';
		await save();
		const res = await request<TelegramMessage>(SEND_METHOD_BY_KIND[media.kind], {
			chat_id: msg.chat.id,
			[media.kind]: media.fileId,
			caption,
			...topic,
			...(msg.caption_entities !== undefined ? { caption_entities: msg.caption_entities } : {}),
		});
		if (!res.ok) return failed('resend_failed', res);
		if (!Number.isSafeInteger(res.result?.message_id) || res.result!.message_id <= 0) {
			return failed('resend_failed', { ok: false, uncertain: true });
		}
		progress.resentMessageId = res.result!.message_id;
		progress.captionPreserved = true;
		delete progress.pendingSend;
		delete progress.retryAt;
		await save();
	}

	while (progress.sentFollowUps < followUpMessages.length) {
		if (budgetExceeded()) return { handled: false, reason: 'time_budget_exceeded', retryAfter: 1 };
		progress.pendingSend = 'follow_up';
		await save();
		const res = await request<TelegramMessage>('sendMessage', {
			chat_id: msg.chat.id,
			text: followUpMessages[progress.sentFollowUps],
			...topic,
			reply_parameters: { message_id: preserveOriginal ? msg.message_id : progress.resentMessageId, allow_sending_without_reply: true },
		});
		if (!res.ok) return failed('follow_up_failed', res);
		if (!Number.isSafeInteger(res.result?.message_id) || res.result!.message_id <= 0) {
			return failed('follow_up_failed', { ok: false, uncertain: true });
		}
		progress.sentFollowUps++;
		delete progress.pendingSend;
		delete progress.retryAt;
		await save();
	}

	if (preserveOriginal) {
		return { handled: true, deletedOriginal: false, sentFollowUps: progress.sentFollowUps };
	}
	if (budgetExceeded()) return { handled: false, reason: 'time_budget_exceeded', retryAfter: 1 };
	const deleteRes = await request<boolean>('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id });
	if (!deleteRes.ok) {
		// Retrying deletion cannot create duplicate files; known permission errors remain non-fatal.
		if (deleteRes.uncertain || (deleteRes.error_code !== 400 && deleteRes.error_code !== 403)) {
			return failed('delete_failed', deleteRes);
		}
		console.warn('Could not delete original Telegram message:', msg.chat.id, msg.message_id, deleteRes.error_code);
	}
	return { handled: true, deletedOriginal: deleteRes.ok, sentFollowUps: progress.sentFollowUps };
}
