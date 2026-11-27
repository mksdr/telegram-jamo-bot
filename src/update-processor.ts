import { DurableObject } from 'cloudflare:workers';
import {
	classifyTelegramUpdate,
	isUpdateComplete,
	processTelegramUpdate,
	type ProcessUpdateProgress,
	type ProcessUpdateResult,
	type TargetMedia,
	type TelegramMessage,
	type TelegramUpdate,
} from './telegram';

interface PendingUpdate {
	update: TelegramUpdate;
	threshold: number;
	progress: ProcessUpdateProgress;
	lastFailure?: ProcessUpdateResult;
	expiresAt?: number;
}

type StoredUpdate = PendingUpdate | { result: ProcessUpdateResult };

const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const EXPIRED_RESULT: ProcessUpdateResult = { handled: false, reason: 'expired_update' };

function sanitizeTelegramUpdate(update: TelegramUpdate, message: TelegramMessage, media: TargetMedia): TelegramUpdate {
	const sanitizedMessage: TelegramMessage = {
		chat: { id: message.chat.id },
		message_id: message.message_id,
		...(message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
		...(message.caption !== undefined ? { caption: message.caption } : {}),
		// Entity metadata is forwarded losslessly when resending the caption.
		...(message.caption_entities !== undefined ? { caption_entities: message.caption_entities } : {}),
		[media.kind]: { file_id: media.fileId, file_name: media.fileName },
	};
	return {
		update_id: update.update_id,
		[update.message == null ? 'channel_post' : 'message']: sanitizedMessage,
	};
}

/** One durable journal per bot/update ID; secrets are passed by RPC, never stored. */
export class TelegramUpdateProcessor extends DurableObject<Env> {
	private inFlight?: Promise<ProcessUpdateResult>;

	async process(update: TelegramUpdate, botToken: string, threshold: number, authorizedChatId?: number): Promise<ProcessUpdateResult> {
		// External fetches yield DO input gates. Coalesce concurrent calls explicitly.
		if (!this.inFlight) {
			this.inFlight = this.run(update, botToken, threshold, authorizedChatId).finally(() => {
				this.inFlight = undefined;
			});
		}
		return this.inFlight;
	}

	private async saveFinalResult(result: ProcessUpdateResult): Promise<ProcessUpdateResult> {
		const deleteAt = Date.now() + RESULT_RETENTION_MS;
		await this.ctx.storage.transaction(async (txn) => {
			await txn.setAlarm(deleteAt);
			await txn.put('update', { result });
		});
		return result;
	}

	private async run(update: TelegramUpdate, botToken: string, threshold: number, authorizedChatId?: number): Promise<ProcessUpdateResult> {
		const stored = await this.ctx.storage.get<StoredUpdate>('update');
		if (stored && 'result' in stored) {
			// Compact legacy completions without extending their existing alarm.
			if ('update' in stored) await this.ctx.storage.put('update', { result: stored.result });
			return stored.result;
		}
		if (stored?.expiresAt !== undefined && stored.expiresAt <= Date.now()) return this.saveFinalResult(EXPIRED_RESULT);

		const source = stored?.update ?? update;
		const classified = classifyTelegramUpdate(source);
		if ('reason' in classified) return classified;
		// Retries use the stored payload. Ensure it targets the chat authorized at the webhook.
		if (authorizedChatId !== undefined && classified.message.chat?.id !== authorizedChatId) {
			return { handled: false, reason: 'chat_not_allowed' };
		}
		const firstFailure =
			!stored?.lastFailure && !stored?.progress.pendingSend && !stored?.progress.blockedSend && stored?.progress.retryAt === undefined;
		const expiresAt = stored?.expiresAt ?? Date.now() + PENDING_RETENTION_MS;
		const state: PendingUpdate = {
			update: sanitizeTelegramUpdate(source, classified.message, classified.media),
			threshold: stored?.threshold ?? threshold,
			progress: stored?.progress ?? { sentFollowUps: 0 },
			...(stored?.lastFailure !== undefined ? { lastFailure: stored.lastFailure } : {}),
			expiresAt,
		};
		if (stored?.expiresAt === undefined) {
			// Arm cleanup before any external call, including attempts interrupted before recording a failure.
			await this.ctx.storage.setAlarm(expiresAt);
			await this.ctx.storage.put('update', state);
		}

		const result = await processTelegramUpdate(state.update, {
			botToken,
			threshold: state.threshold,
			progress: state.progress,
			saveProgress: async () => {
				await this.ctx.storage.put('update', state);
			},
		});
		if (isUpdateComplete(result)) return this.saveFinalResult(result);
		if (result.needsReconciliation) console.error('Telegram delivery requires reconciliation:', state.update.update_id, result.reason);
		if (firstFailure && stored?.expiresAt === undefined) {
			state.expiresAt = Date.now() + PENDING_RETENTION_MS;
			if (state.expiresAt !== expiresAt) await this.ctx.storage.setAlarm(state.expiresAt);
		}
		state.lastFailure = result;
		await this.ctx.storage.put('update', state);
		return result;
	}

	async alarm(): Promise<void> {
		// The processor may replace the pending alarm with completion cleanup. Read its final journal even if processing failed.
		while (this.inFlight) await this.inFlight.catch(() => undefined);
		const state = await this.ctx.storage.get<StoredUpdate>('update');
		if (!state) return;
		if ('result' in state) {
			// Processing may have scheduled result cleanup while this alarm was running.
			if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.deleteAll();
			return;
		}

		const now = Date.now();
		if (state.expiresAt === undefined) {
			// Legacy journals did not record when the first failure occurred.
			state.expiresAt = now + PENDING_RETENTION_MS;
			await this.ctx.storage.setAlarm(state.expiresAt);
			await this.ctx.storage.put('update', state);
		} else if (state.expiresAt > now) {
			await this.ctx.storage.setAlarm(state.expiresAt);
		} else {
			await this.saveFinalResult(EXPIRED_RESULT);
		}
	}
}
