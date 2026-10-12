import type { WorkerEnv } from "./env";

export async function notifyFailure(env: WorkerEnv, payload: Record<string, string | number | boolean | null>): Promise<void> {
	const url = env.FAILURE_WEBHOOK_URL;
	if (!url) return;
	try {
		await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (error) {
		console.error(JSON.stringify({ event: "webhook.failed", message: error instanceof Error ? error.message : String(error) }));
	}
}
