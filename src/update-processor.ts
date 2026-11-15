import { DurableObject } from "cloudflare:workers";
import { isUpdateComplete, processTelegramUpdate, type ProcessUpdateProgress, type ProcessUpdateResult, type TelegramUpdate } from "./telegram";

interface StoredUpdate {
	update: TelegramUpdate;
	threshold: number;
	progress: ProcessUpdateProgress;
	result?: ProcessUpdateResult;
	lastFailure?: ProcessUpdateResult;
}

const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One durable journal per bot/update ID; secrets are passed by RPC, never stored. */
export class TelegramUpdateProcessor extends DurableObject<Env> {
	private inFlight?: Promise<ProcessUpdateResult>;

	async process(update: TelegramUpdate, botToken: string, threshold: number): Promise<ProcessUpdateResult> {
		// External fetches yield DO input gates. Coalesce concurrent calls explicitly.
		if (!this.inFlight) {
			this.inFlight = this.run(update, botToken, threshold).finally(() => { this.inFlight = undefined; });
		}
		return this.inFlight;
	}

	private async run(update: TelegramUpdate, botToken: string, threshold: number): Promise<ProcessUpdateResult> {
		let state = await this.ctx.storage.get<StoredUpdate>("update");
		if (state?.result) return state.result;
		if (!state) {
			state = { update, threshold, progress: { sentFollowUps: 0 } };
			await this.ctx.storage.put("update", state);
		}
		const checkpoint = state;
		const result = await processTelegramUpdate(state.update, {
			botToken,
			threshold: state.threshold,
			progress: state.progress,
			saveProgress: async () => { await this.ctx.storage.put("update", checkpoint); },
		});
		if (isUpdateComplete(result)) {
			// Schedule before recording completion, so a failed alarm write can be retried.
			await this.ctx.storage.setAlarm(Date.now() + COMPLETED_RETENTION_MS);
			state.result = result;
			delete state.lastFailure;
		} else {
			state.lastFailure = result;
			if (result.needsReconciliation) console.error("Telegram delivery requires reconciliation:", state.update.update_id);
		}
		await this.ctx.storage.put("update", state);
		return result;
	}

	async alarm(): Promise<void> {
		const state = await this.ctx.storage.get<StoredUpdate>("update");
		// Failed/uncertain work is retained for operator recovery, never silently expired.
		if (state?.result) await this.ctx.storage.deleteAll();
	}
}
