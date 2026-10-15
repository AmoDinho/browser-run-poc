import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { analyseAsset, recordTerminalFailure } from "./analysis/analyse";
import { AnalysisRequestError } from "./analysis/client";
import { ConfigError, QuotaError, captureAsset, toStepResult, type CaptureStepResult } from "./capture/browser";
import { DAILY_TIMEFRAMES } from "./capture/config";
import type { WorkerEnv } from "./env";
import { instanceId, normalizeParams, type DailyParams } from "./workflow-params";

export class DailyAnalysisWorkflow extends WorkflowEntrypoint<WorkerEnv, DailyParams> {
	async run(event: WorkflowEvent<DailyParams>, step: WorkflowStep) {
		let params: DailyParams;
		try {
			params = normalizeParams(event.payload);
		} catch (error) {
			throw new NonRetryableError(error instanceof Error ? error.message : "invalid workflow params");
		}
		const results: { asset: string; ok: boolean; skipped?: boolean }[] = [];
		for (const asset of params.assets) {
			let capture: CaptureStepResult | null = null;
			if (params.phase === "full") {
				try {
					capture = await step.do(
						`capture-${asset}`,
						{ retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "8 minutes" },
						async () => {
							try {
								const result = await captureAsset(this.env, {
									asset,
									date: params.date,
									timeframes: DAILY_TIMEFRAMES,
									force: params.force,
									store: true,
								});
								if (result.actualTimeframes.length === 0) {
									throw new Error(result.notes.join("; ") || "capture produced no images");
								}
								return toStepResult(result);
							} catch (error) {
								if (error instanceof QuotaError || error instanceof ConfigError) throw new NonRetryableError(error.message);
								throw error;
							}
						},
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await step.do(`capture-failed-${asset}`, async () => {
						await recordTerminalFailure(this.env, { asset, date: params.date, force: params.force, runId: params.runId, capture: null }, message);
						return { recorded: true };
					});
					results.push({ asset, ok: false });
					continue;
				}
			}
			try {
				const analysed = await step.do(
					`analyse-${asset}`,
					{ retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "10 minutes" },
					async () => {
						try {
							return await analyseAsset(this.env, {
								asset,
								date: params.date,
								force: params.force,
								runId: params.runId,
								capture,
							});
						} catch (error) {
							if (error instanceof AnalysisRequestError && !error.retryable) throw new NonRetryableError(error.message);
							throw error;
						}
					},
				);
				results.push({ asset, ok: analysed.ok, skipped: analysed.skipped });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await step.do(`analyse-failed-${asset}`, async () => {
					await recordTerminalFailure(this.env, { asset, date: params.date, force: params.force, runId: params.runId, capture }, message);
					return { recorded: true };
				});
				results.push({ asset, ok: false });
			}
		}
		return { date: params.date, runId: params.runId, results };
	}
}

export async function startDaily(env: WorkerEnv, params: DailyParams): Promise<{ id: string; created: boolean }> {
	const normalized = normalizeParams(params);
	const id = instanceId(normalized);
	try {
		const instance = await env.DAILY_ANALYSIS.create({ id, params: normalized });
		return { id: instance.id, created: true };
	} catch (error) {
		try {
			const existing = await env.DAILY_ANALYSIS.get(id);
			return { id: existing.id, created: false };
		} catch {
			throw error;
		}
	}
}
