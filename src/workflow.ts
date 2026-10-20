import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	completeAnalysisChat,
	correctionText,
	persistAnalysis,
	prepareAnalysis,
	recordTerminalFailure,
	recordUnusable,
	type AnalyseInput,
	type AnalyseResult,
	type ChatStepResult,
	type PrepareResult,
} from "./analysis/analyse";
import { AnalysisRequestError } from "./analysis/client";
import {
	ConfigError,
	QuotaError,
	captureAsset,
	isFatalCaptureMessage,
	mergeCaptureResults,
	missedCapture,
	shouldRetryCapture,
	toStepResult,
	type CaptureStepResult,
} from "./capture/browser";
import { DAILY_TIMEFRAMES } from "./capture/config";
import type { WorkerEnv } from "./env";
import { sendMorningDigest, type MorningAsset } from "./notify";
import { writeBrief } from "./report/brief";
import { instanceId, normalizeParams, type DailyParams } from "./workflow-params";

const CHAT_STEP = { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "10 minutes" } as const;
const PARSE_STEP = { retries: { limit: 1, delay: "10 seconds", backoff: "constant" }, timeout: "2 minutes" } as const;

export class DailyAnalysisWorkflow extends WorkflowEntrypoint<WorkerEnv, DailyParams> {
	async run(event: WorkflowEvent<DailyParams>, step: WorkflowStep) {
		let params: DailyParams;
		try {
			params = normalizeParams(event.payload);
		} catch (error) {
			throw new NonRetryableError(error instanceof Error ? error.message : "invalid workflow params");
		}
		const results: { asset: string; ok: boolean; skipped?: boolean }[] = [];
		const outcomes: MorningAsset[] = [];
		for (const asset of params.assets) {
			let capture: CaptureStepResult | null = null;
			if (params.phase === "full") {
				capture = await captureAssetSteps(this.env, step, params, asset);
				if (capture.actualTimeframes.length === 0) {
					const message = capture.notes.join("; ") || "capture produced no images";
					await step.do(`capture-failed-${asset}`, async () => {
						await recordTerminalFailure(this.env, { asset, date: params.date, force: params.force, runId: params.runId, capture: null }, message);
						return { recorded: true };
					});
					results.push({ asset, ok: false });
					outcomes.push({ asset, ok: false, error: message });
					continue;
				}
			}
			try {
				const analysed = await analyseAssetSteps(this.env, step, params, asset, capture);
				if (!analysed.ok) {
					results.push({ asset, ok: false });
					outcomes.push({ asset, ok: false, error: analysed.error ?? "analysis failed" });
					continue;
				}
				try {
					await step.do(`brief-${asset}`, { retries: { limit: 1, delay: "10 seconds" }, timeout: "1 minute" }, async () => {
						await writeBrief(this.env, asset, params.date);
						return { written: true };
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					results.push({ asset, ok: false });
					outcomes.push({ asset, ok: false, error: message });
					continue;
				}
				results.push({ asset, ok: true, skipped: analysed.skipped });
				outcomes.push({ asset, ok: true, error: null });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await step.do(`analyse-failed-${asset}`, async () => {
					await recordTerminalFailure(this.env, { asset, date: params.date, force: params.force, runId: params.runId, capture }, message);
					return { recorded: true };
				});
				results.push({ asset, ok: false });
				outcomes.push({ asset, ok: false, error: message });
			}
		}
		await step.do("notify-morning", { retries: { limit: 2, delay: "20 seconds", backoff: "constant" }, timeout: "1 minute" }, async () => {
			return sendMorningDigest(this.env, params.date, outcomes);
		});
		return { date: params.date, runId: params.runId, results };
	}
}

async function captureAssetSteps(
	env: WorkerEnv,
	step: WorkflowStep,
	params: DailyParams,
	asset: string,
): Promise<CaptureStepResult> {
	const requested = [...DAILY_TIMEFRAMES];
	const parts: CaptureStepResult[] = [];
	const priorHashes: string[] = [];
	for (const timeframe of requested) {
		try {
			const part = await step.do(
				`capture-${asset}-${timeframe}`,
				{ retries: { limit: 2, delay: "20 seconds", backoff: "exponential" }, timeout: "4 minutes" },
				async () => {
					try {
						const result = await captureAsset(env, {
							asset,
							date: params.date,
							timeframes: [timeframe],
							force: params.force,
							store: true,
							priorHashes,
						});
						if (shouldRetryCapture(result)) {
							throw new Error(result.notes.join("; ") || `${timeframe}: capture produced no image`);
						}
						return toStepResult(result);
					} catch (error) {
						if (error instanceof QuotaError || error instanceof ConfigError) throw new NonRetryableError(error.message);
						throw error;
					}
				},
			);
			parts.push(part);
			for (const frame of part.frames) {
				if (frame.hash) priorHashes.push(frame.hash);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			parts.push(missedCapture(asset, params.date, timeframe, message));
			if (isFatalCaptureMessage(message)) break;
		}
	}
	return mergeCaptureResults(asset, params.date, requested, parts);
}

async function analyseAssetSteps(
	env: WorkerEnv,
	step: WorkflowStep,
	params: DailyParams,
	asset: string,
	capture: CaptureStepResult | null,
): Promise<AnalyseResult> {
	const input: AnalyseInput = { asset, date: params.date, force: params.force, runId: params.runId, capture };
	const prepared = await step.do(
		`analyse-prepare-${asset}`,
		{ retries: { limit: 1, delay: "10 seconds" }, timeout: "2 minutes" },
		() => guardAnalysis(() => prepareAnalysis(env, input)),
	);
	if (!prepared.ok || prepared.skipped) {
		return { ok: prepared.ok, skipped: prepared.skipped, groundingWarning: false, error: prepared.error };
	}
	let chat = await step.do(`analyse-chat-${asset}`, CHAT_STEP, () => chatStep(env, input, prepared, null));
	let retried = false;
	if (chat.unusable) {
		retried = true;
		chat = await step.do(`analyse-chat-retry-${asset}`, CHAT_STEP, async () => {
			const result = await chatStep(env, input, prepared, null);
			if (result.unusable) await recordUnusable(env, input, prepared, "empty or truncated content");
			return result;
		});
	}
	if (!chat.ok || chat.unusable) {
		return { ok: false, skipped: false, groundingWarning: false, error: chat.error ?? "empty or truncated content" };
	}
	let parsed = await step.do(`analyse-parse-${asset}`, PARSE_STEP, () => guardAnalysis(() => persistAnalysis(env, input, prepared, !retried)));
	if (parsed.needsRetry) {
		const detail = parsed.error ?? "validation failed";
		const corrected = await step.do(`analyse-chat-correct-${asset}`, CHAT_STEP, async () => {
			const result = await chatStep(env, input, prepared, correctionText(detail));
			if (result.unusable) await recordUnusable(env, input, prepared, "retry empty or truncated");
			return result;
		});
		if (!corrected.ok || corrected.unusable) {
			return { ok: false, skipped: false, groundingWarning: false, error: corrected.error ?? "retry empty or truncated" };
		}
		parsed = await step.do(`analyse-parse-retry-${asset}`, PARSE_STEP, () => guardAnalysis(() => persistAnalysis(env, input, prepared, false)));
	}
	return { ok: parsed.ok, skipped: parsed.skipped, groundingWarning: parsed.groundingWarning, error: parsed.error };
}

async function chatStep(
	env: WorkerEnv,
	input: AnalyseInput,
	prepared: PrepareResult,
	correction: string | null,
): Promise<ChatStepResult> {
	return guardAnalysis(() => completeAnalysisChat(env, input, prepared, correction));
}

async function guardAnalysis<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof AnalysisRequestError && !error.retryable) throw new NonRetryableError(error.message);
		throw error;
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
