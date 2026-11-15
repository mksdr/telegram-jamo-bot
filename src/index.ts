import { DEFAULT_FULL_MODE_THRESHOLD } from "./hangul";
import { processTelegramUpdate, type TelegramUpdate } from "./telegram";

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
			if (env.TELEGRAM_WEBHOOK_SECRET) {
				const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
				if (!providedSecret || !safeEqual(providedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
					return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
				}
			}

			let update: TelegramUpdate;
			try {
				update = (await request.json()) as TelegramUpdate;
			} catch {
				return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
			}

			if (!update || typeof update !== "object" || typeof update.update_id !== "number") {
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

			ctx.waitUntil(
				processTelegramUpdate(update, {
					botToken: env.TELEGRAM_BOT_TOKEN,
					threshold,
				}).catch((error) => {
					console.error("Unhandled Telegram update processing error:", error);
				}),
			);

			return Response.json({ ok: true }, { status: 200 });
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
