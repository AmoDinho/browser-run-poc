import { isAsset, isUtcDate, type Asset } from "./capture/config";

export const NASDAQ_CRON = "0 7 * * 1-5";
export const GOLD_CRON = "10 7 * * 1-5";

export type DailyPhase = "full" | "analyse";

export type DailyParams = {
	date: string;
	force: boolean;
	assets: Asset[];
	phase: DailyPhase;
	runId: string;
};

export function normalizeParams(payload: unknown): DailyParams {
	if (!payload || typeof payload !== "object") throw new Error("workflow params missing");
	const row = payload as Record<string, unknown>;
	if (typeof row.date !== "string" || !isUtcDate(row.date)) throw new Error("workflow date invalid");
	if (typeof row.runId !== "string" || !row.runId) throw new Error("workflow runId missing");
	if (row.phase !== "full" && row.phase !== "analyse") throw new Error("workflow phase invalid");
	if (!Array.isArray(row.assets) || row.assets.length === 0 || row.assets.some((asset) => typeof asset !== "string" || !isAsset(asset))) {
		throw new Error("workflow assets invalid");
	}
	const requestedForce = row.force === true;
	return {
		date: row.date,
		force: row.runId.startsWith("cron-") ? false : requestedForce,
		assets: row.assets,
		phase: row.phase,
		runId: row.runId,
	};
}

export function instanceId(params: DailyParams): string {
	if (!params.force && params.phase === "full" && params.assets.length === 1) {
		return `cron-${params.assets[0]}-${params.date}`;
	}
	if (!params.force && params.phase === "analyse" && params.assets.length === 1) return `analyse-${params.assets[0]}-${params.date}`;
	if (!params.force && params.phase === "analyse") return `analyse-${params.date}`;
	const suffix = params.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
	return `run-${suffix}`.slice(0, 100);
}

export function assetForCron(cron: string): Asset | null {
	const normalized = cron.trim().replace(/\s+/g, " ").toUpperCase();
	if (normalized === NASDAQ_CRON.toUpperCase() || normalized === "0 7 * * MON-FRI") return "nasdaq100";
	if (normalized === GOLD_CRON.toUpperCase() || normalized === "10 7 * * MON-FRI") return "gold";
	return null;
}

export function runIdFor(phase: DailyPhase, date: string, force: boolean, asset: Asset): string {
	if (!force && phase === "full") return `cron-${asset}-${date}`;
	if (!force && phase === "analyse") return `analyse-${asset}-${date}`;
	return `${phase}-${asset}-${date}-${Date.now()}`;
}
