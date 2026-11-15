import { DEFAULT_FULL_MODE_THRESHOLD } from "./hangul";
import { isUpdateComplete, type TelegramUpdate } from "./telegram";

export { TelegramUpdateProcessor } from "./update-processor";

/**
 * Constant-time string comparison to avoid timing leaks on webhook secret verification.
 */
function safeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const bytesA = encoder.encode(a);
	const bytesB = encoder.encode(b);
	if (bytesA.length !== bytesB.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= bytesA[i] ^ bytesB[i];
	}
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
			return new Response("Telegram Jamo Bot is running.", { status: 200 });
		}

		if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/")) {
			if (!env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
				console.error("Missing TELEGRAM_WEBHOOK_SECRET environment secret.");
				return Response.json({ ok: false, error: "Webhook secret not configured" }, { status: 503 });
			}
			const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
			if (!providedSecret || !safeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
				return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
			}

			let update: TelegramUpdate;
			try {
				update = (await request.json()) as TelegramUpdate;
			} catch {
				return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
			}

			if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
				return Response.json({ ok: false, error: "Invalid Telegram update" }, { status: 400 });
			}

			if (!env.TELEGRAM_BOT_TOKEN) {
				console.error("Missing TELEGRAM_BOT_TOKEN environment secret.");
				return Response.json({ ok: false, error: "Bot token not configured" }, { status: 500 });
			}

			const parsedThreshold = Number.parseInt(env.FULL_MODE_THRESHOLD ?? "", 10);
			const threshold =
				Number.isFinite(parsedThreshold) && parsedThreshold > 0
					? parsedThreshold
					: DEFAULT_FULL_MODE_THRESHOLD;

			try {
				const botId = env.TELEGRAM_BOT_TOKEN.split(":")[0];
				const processor = env.TELEGRAM_UPDATES.getByName(`${botId}:${update.update_id}`);
				const result = await processor.process(update, env.TELEGRAM_BOT_TOKEN, threshold);
				if (!isUpdateComplete(result)) {
					console.error("Telegram update incomplete:", update.update_id, result.reason);
					return Response.json({ ok: false, error: "Telegram update processing incomplete" }, {
						status: 503,
						headers: { "Retry-After": String(result.retryAfter ?? 1) },
					});
				}
			} catch {
				// Do not acknowledge a storage/RPC failure or log URLs containing the bot token.
				console.error("Telegram update processing failed:", update.update_id);
				return Response.json({ ok: false, error: "Telegram update processing failed" }, { status: 503 });
			}

			return Response.json({ ok: true }, { status: 200 });
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
