import { DAILY_TIMEFRAMES, TIMEFRAME_LABELS, isAsset, isTimeframe, isUtcDate, utcDate, type Asset } from "./capture/config";
import { captureScreenshot, checkLimits, cleanupSessions, readStatus } from "./capture/browser";
import type { WorkerEnv } from "./env";
import { reportPage, reportsListPage } from "./report/html";
import { arrayBuffer } from "./capture/visibility";
import { getBytes, getText, listReportEntries, reportMdKey, screenshotKey } from "./storage/kv";
import { startDaily } from "./workflow";

export { DailyAnalysisWorkflow } from "./workflow";

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname, searchParams } = url;
		if (pathname === "/status") return status(env);
		if (pathname === "/cleanup") return cleanup(env);
		if (pathname === "/screenshot") return screenshot(searchParams, env);
		if (pathname === "/latest") return latest(searchParams, env);
		if (pathname === "/reports" || pathname.startsWith("/reports/")) return reports(url, env);
		if (pathname === "/run") return trigger(url, env, "full");
		if (pathname === "/analyse") return trigger(url, env, "analyse");
		return json({
			message: "FX Daily Chart Worker is ready.",
			schedule: "07:00 UTC Mon-Fri",
			decisions: {
				timeframes: DAILY_TIMEFRAMES,
				assets: ["nasdaq100", "gold"],
				model: "deepseek-flash",
			},
			endpoints: {
				status: "/status",
				cleanup: "/cleanup",
				screenshot: "/screenshot?asset=[nasdaq100|gold]&timeframe=[30m|3h|1D|1W|1M|3M|1Y]",
				latest: "/latest?asset=[nasdaq100|gold]&timeframe=[30m|3h|1D|1W|1M|3M|1Y]",
				reports: "/reports?token=…",
				run: "/run?token=…&force=1",
				analyse: "/analyse?token=…&asset=gold&date=YYYY-MM-DD&force=1",
			},
		});
	},
	async scheduled(event, env, ctx): Promise<void> {
		const date = new Date(event.scheduledTime).toISOString().slice(0, 10);
		ctx.waitUntil(startScheduled(env, date));
	},
} satisfies ExportedHandler<WorkerEnv>;

async function startScheduled(env: WorkerEnv, date: string): Promise<void> {
	try {
		const started = await startDaily(env, {
			date,
			force: false,
			assets: ["nasdaq100", "gold"],
			phase: "full",
			runId: `cron-${date}`,
		});
		console.log(JSON.stringify({ event: "cron.started", ...started, date }));
	} catch (error) {
		console.error(JSON.stringify({ event: "cron.failed", date, message: error instanceof Error ? error.message : String(error) }));
	}
}

async function status(env: WorkerEnv): Promise<Response> {
	try {
		return json(await readStatus(env));
	} catch (error) {
		return json({ error: message(error), stack: error instanceof Error ? error.stack : undefined }, 500);
	}
}

async function cleanup(env: WorkerEnv): Promise<Response> {
	try {
		const result = await cleanupSessions(env);
		return json({ message: `Attempted to close ${result.count} sessions`, closed: result.closed });
	} catch (error) {
		return json({ error: message(error), stack: error instanceof Error ? error.stack : undefined }, 500);
	}
}

async function screenshot(searchParams: URLSearchParams, env: WorkerEnv): Promise<Response> {
	const asset = searchParams.get("asset") ?? "nasdaq100";
	const timeframe = searchParams.get("timeframe") ?? "1D";
	if (!isAsset(asset)) return json({ error: `Invalid asset. Supported assets: nasdaq100, gold` }, 400);
	if (!isTimeframe(timeframe)) return json({ error: `Invalid timeframe. Supported: ${Object.keys(TIMEFRAME_LABELS).join(", ")}` }, 400);
	const limit = await checkLimits(env);
	if (!limit.allowed) return limit.response;
	try {
		const img = await captureScreenshot(asset, timeframe, env);
		return new Response(arrayBuffer(img), { headers: { "content-type": "image/png" } });
	} catch (error) {
		return json({ error: message(error), stack: error instanceof Error ? error.stack : undefined }, 500);
	}
}

async function latest(searchParams: URLSearchParams, env: WorkerEnv): Promise<Response> {
	const asset = searchParams.get("asset") ?? "nasdaq100";
	const timeframe = searchParams.get("timeframe") ?? "1D";
	if (!env.CHARTS_CACHE) return json({ error: "CHARTS_CACHE namespace binding is not configured in this environment." }, 500);
	const image = await getBytes(env.CHARTS_CACHE, `${asset}/${timeframe}/latest.png`);
	if (!image) return json({ error: `No stored screenshot found for asset '${asset}' with timeframe '${timeframe}'.` }, 404);
	return new Response(arrayBuffer(image), { headers: { "content-type": "image/png" } });
}

async function reports(url: URL, env: WorkerEnv): Promise<Response> {
	if (!viewerAllowed(url, env)) return notFound();
	const token = url.searchParams.get("token") ?? "";
	const parts = url.pathname.split("/").filter(Boolean);
	if (!env.CHARTS_CACHE) return notFound();
	if (parts.length === 1) {
		const rows = await listReportEntries(env.CHARTS_CACHE);
		return html(reportsListPage(rows, token));
	}
	const asset = parts[1] ?? "";
	const date = parts[2] ?? "";
	if (!isAsset(asset) || !isUtcDate(date)) return notFound();
	if (parts.length === 4 && parts[3]?.endsWith(".png")) {
		const timeframe = parts[3].slice(0, -4);
		if (!isTimeframe(timeframe)) return notFound();
		const image = await getBytes(env.CHARTS_CACHE, screenshotKey(asset, timeframe, date));
		if (!image) return notFound();
		return new Response(arrayBuffer(image), { headers: { "content-type": "image/png", "x-content-type-options": "nosniff" } });
	}
	if (parts.length !== 3) return notFound();
	const markdown = await getText(env.CHARTS_CACHE, reportMdKey(asset, date));
	if (!markdown) return notFound();
	return html(reportPage({
		title: `${asset} ${date}`,
		markdown,
		imagePrefix: `/reports/${asset}/${date}`,
		token,
	}));
}

async function trigger(url: URL, env: WorkerEnv, phase: "full" | "analyse"): Promise<Response> {
	if (!viewerAllowed(url, env)) return notFound();
	const date = url.searchParams.get("date") ?? utcDate();
	if (!isUtcDate(date)) return json({ error: "invalid date" }, 400);
	const force = url.searchParams.get("force") === "1";
	const assetParam = url.searchParams.get("asset");
	let assets: Asset[] = ["nasdaq100", "gold"];
	if (assetParam) {
		if (!isAsset(assetParam)) return json({ error: "invalid asset" }, 400);
		assets = [assetParam];
	}
	try {
		const started = await startDaily(env, {
			date,
			force,
			assets,
			phase,
			runId: runIdFor(phase, date, force, assets),
		});
		return json(started, 202);
	} catch (error) {
		return json({ error: message(error) }, 500);
	}
}

function runIdFor(phase: "full" | "analyse", date: string, force: boolean, assets: Asset[]): string {
	if (!force && phase === "full" && assets.length === 2) return `cron-${date}`;
	if (!force && phase === "analyse" && assets.length === 1) return `analyse-${assets[0]}-${date}`;
	if (!force && phase === "analyse") return `analyse-${date}`;
	return `${phase}-${date}-${Date.now()}`;
}

function viewerAllowed(url: URL, env: WorkerEnv): boolean {
	const expected = env.VIEWER_TOKEN;
	const provided = url.searchParams.get("token");
	if (!expected || !provided) return false;
	return timingSafeEqual(provided, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const left = enc.encode(a);
	const right = enc.encode(b);
	const len = Math.max(left.length, right.length);
	let diff = left.length ^ right.length;
	for (let i = 0; i < len; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

function notFound(): Response {
	return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function html(body: string): Response {
	return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
