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
}

type StoredUpdate = PendingUpdate | { result: ProcessUpdateResult };

const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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

	async process(update: TelegramUpdate, botToken: string, threshold: number): Promise<ProcessUpdateResult> {
		// External fetches yield DO input gates. Coalesce concurrent calls explicitly.
		if (!this.inFlight) {
			this.inFlight = this.run(update, botToken, threshold).finally(() => {
				this.inFlight = undefined;
			});
		}
		return this.inFlight;
	}

	private async run(update: TelegramUpdate, botToken: string, threshold: number): Promise<ProcessUpdateResult> {
		const stored = await this.ctx.storage.get<StoredUpdate>('update');
		if (stored && 'result' in stored) {
			// Compact legacy completions without extending their existing alarm.
			if ('update' in stored) await this.ctx.storage.put('update', { result: stored.result });
			return stored.result;
		}

		const source = stored?.update ?? update;
		const classified = classifyTelegramUpdate(source);
		if ('reason' in classified) return classified;
		const state: PendingUpdate = {
			update: sanitizeTelegramUpdate(source, classified.message, classified.media),
			threshold: stored?.threshold ?? threshold,
			progress: stored?.progress ?? { sentFollowUps: 0 },
			...(stored?.lastFailure !== undefined ? { lastFailure: stored.lastFailure } : {}),
		};
		if (!stored) await this.ctx.storage.put('update', state);

		const result = await processTelegramUpdate(state.update, {
			botToken,
			threshold: state.threshold,
			progress: state.progress,
			saveProgress: async () => {
				await this.ctx.storage.put('update', state);
			},
		});
		if (isUpdateComplete(result)) {
			// Schedule before recording completion, so a failed alarm write can be retried.
			await this.ctx.storage.setAlarm(Date.now() + COMPLETED_RETENTION_MS);
			await this.ctx.storage.put('update', { result });
			return result;
		}
		state.lastFailure = result;
		if (result.needsReconciliation) console.error('Telegram delivery requires reconciliation:', state.update.update_id);
		await this.ctx.storage.put('update', state);
		return result;
	}

	async alarm(): Promise<void> {
		const state = await this.ctx.storage.get<StoredUpdate>('update');
		// Failed/uncertain work is retained for operator recovery, never silently expired.
		if (state && 'result' in state) await this.ctx.storage.deleteAll();
	}
}
