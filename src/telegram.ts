import { generateSearchTokens, splitCaptionAndFollowUps } from "./hangul";

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramFileAttachment {
	file_id: string;
	file_unique_id?: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramMessage {
	message_id: number;
	message_thread_id?: number;
	from?: TelegramUser;
	chat: TelegramChat;
	caption?: string;
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

export type SupportedMediaKind = "document" | "audio" | "video" | "animation";

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
}

export interface ProcessUpdateOptions {
	botToken: string;
	threshold?: number;
	fetchImpl?: typeof fetch;
}

export interface ProcessUpdateResult {
	handled: boolean;
	reason?: string;
	deletedOriginal?: boolean;
	sentFollowUps?: number;
}

const SEND_METHOD_BY_KIND: Record<SupportedMediaKind, string> = {
	document: "sendDocument",
	audio: "sendAudio",
	video: "sendVideo",
	animation: "sendAnimation",
};

/**
 * Extracts a supported file attachment and its filename from a Telegram message.
 */
export function extractTargetMedia(message: TelegramMessage): TargetMedia | null {
	const candidates: Array<{
		kind: SupportedMediaKind;
		attachment?: TelegramFileAttachment & { title?: string };
	}> = [
		{ kind: "document", attachment: message.document },
		{ kind: "audio", attachment: message.audio },
		{ kind: "video", attachment: message.video },
		{ kind: "animation", attachment: message.animation },
	];

	for (const { kind, attachment } of candidates) {
		if (!attachment?.file_id) continue;
		const rawName =
			attachment.file_name?.trim() ||
			(kind === "audio" ? attachment.title?.trim() : undefined);
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

/**
 * Calls a Telegram Bot API method safely, catching network and JSON parsing errors.
 */
export async function callTelegramApi<T = unknown>(
	botToken: string,
	method: string,
	payload: Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
): Promise<TelegramApiResponse<T>> {
	try {
		const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		const data = (await response.json()) as TelegramApiResponse<T>;
		if (!data || typeof data.ok !== "boolean") {
			return {
				ok: false,
				error_code: response.status,
				description: `Unexpected Telegram API response status ${response.status}`,
			};
		}
		return data;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			description: `Telegram API request failed for ${method}: ${message}`,
		};
	}
}

/**
 * Processes an incoming Telegram Update: generates search tokens from the file name,
 * re-sends the file with the generated caption, posts any overflow as reply messages,
 * and attempts to delete the original file message without failing if permissions are missing.
 */
export async function processTelegramUpdate(
	update: TelegramUpdate,
	options: ProcessUpdateOptions,
): Promise<ProcessUpdateResult> {
	const msg = update.message ?? update.channel_post;
	if (!msg) {
		return { handled: false, reason: "no_message" };
	}

	if (msg.from?.is_bot) {
		return { handled: false, reason: "from_bot" };
	}

	const media = extractTargetMedia(msg);
	if (!media) {
		return { handled: false, reason: "no_supported_file" };
	}

	const { text } = generateSearchTokens(media.fileName, options.threshold);
	if (!text) {
		return { handled: false, reason: "empty_tokens" };
	}

	const { caption, followUpMessages } = splitCaptionAndFollowUps(text, msg.caption);
	const fetchImpl = options.fetchImpl ?? fetch;

	// Step A: Re-send file with generated caption (do not delete original if this fails)
	let resentMessageId: number | undefined;
	try {
		const sendMethod = SEND_METHOD_BY_KIND[media.kind];
		const sendPayload: Record<string, unknown> = {
			chat_id: msg.chat.id,
			[media.kind]: media.fileId,
			caption,
			...(msg.message_thread_id !== undefined
				? { message_thread_id: msg.message_thread_id }
				: {}),
		};

		const resendRes = await callTelegramApi<TelegramMessage>(
			options.botToken,
			sendMethod,
			sendPayload,
			fetchImpl,
		);

		if (!resendRes.ok) {
			console.error(
				`Failed to resend ${media.kind} in chat ${msg.chat.id}: ${resendRes.error_code ?? ""} ${resendRes.description ?? "unknown error"}`,
			);
			return { handled: false, reason: "resend_failed" };
		}

		resentMessageId = resendRes.result?.message_id;
	} catch (error) {
		console.error(`Unexpected error resending ${media.kind} in chat ${msg.chat.id}:`, error);
		return { handled: false, reason: "resend_failed" };
	}

	// Step B: Send overflow tokens as follow-up reply messages
	let sentFollowUps = 0;
	for (const chunk of followUpMessages) {
		try {
			const followUpPayload: Record<string, unknown> = {
				chat_id: msg.chat.id,
				text: chunk,
				...(msg.message_thread_id !== undefined
					? { message_thread_id: msg.message_thread_id }
					: {}),
				...(resentMessageId !== undefined
					? {
							reply_parameters: {
								message_id: resentMessageId,
								allow_sending_without_reply: true,
							},
						}
					: {}),
			};

			const replyRes = await callTelegramApi<TelegramMessage>(
				options.botToken,
				"sendMessage",
				followUpPayload,
				fetchImpl,
			);

			if (replyRes.ok) {
				sentFollowUps++;
			} else {
				console.warn(
					`Failed to send follow-up message in chat ${msg.chat.id}: ${replyRes.error_code ?? ""} ${replyRes.description ?? "unknown error"}`,
				);
			}
		} catch (error) {
			console.warn(`Unexpected error sending follow-up message in chat ${msg.chat.id}:`, error);
		}
	}

	// Step C: Attempt to delete original message (gracefully ignore lack of permissions)
	let deletedOriginal = false;
	try {
		const deleteRes = await callTelegramApi<boolean>(
			options.botToken,
			"deleteMessage",
			{
				chat_id: msg.chat.id,
				message_id: msg.message_id,
			},
			fetchImpl,
		);

		if (deleteRes.ok) {
			deletedOriginal = true;
		} else {
			console.warn(
				`Could not delete original message ${msg.message_id} in chat ${msg.chat.id}: ${deleteRes.error_code ?? ""} ${deleteRes.description ?? "unknown error"}`,
			);
		}
	} catch (error) {
		console.warn(
			`Unexpected error deleting original message ${msg.message_id} in chat ${msg.chat.id}:`,
			error,
		);
	}

	return {
		handled: true,
		deletedOriginal,
		sentFollowUps,
	};
}
