import { isAsset, isUtcDate, type Asset } from "./capture/config";

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
	if (!params.force && params.phase === "full" && params.assets.length === 2) return `cron-${params.date}`;
	if (!params.force && params.phase === "analyse" && params.assets.length === 1) return `analyse-${params.assets[0]}-${params.date}`;
	if (!params.force && params.phase === "analyse") return `analyse-${params.date}`;
	const suffix = params.runId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60);
	return `run-${suffix}`.slice(0, 100);
}
