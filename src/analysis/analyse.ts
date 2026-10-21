import { Buffer } from "node:buffer";
import { ZodError } from "zod";
import { DAILY_TIMEFRAMES, TIMEFRAME_LABELS, isTimeframe } from "../capture/config";
import { pngFailsVisibility } from "../capture/visibility";
import type { CaptureStepResult } from "../capture/browser";
import type { WorkerEnv } from "../env";
import { logEvent } from "../observe";
import { notifyFailure } from "../notify";
import { renderReport } from "../report/render";
import { completionDraftKey, getBytes, getText, putText, reportJsonKey, reportMdKey, runKey, screenshotKey } from "../storage/kv";
import { AnalysisRequestError, completeChat, resolveModel } from "./client";
import { compressModelImage, loadModelImages } from "./images";
import { isUnusableCompletion, parseAnalysis } from "./parse";
import { CITABLE_SECTIONS, PROMPT_VERSION } from "./prompt";
import { buildRunContext, buildUserContent, type UserPart } from "./request";
import { SCHEMA_VERSION, chartAnalysisSchema, type ChartAnalysis } from "./schema";

export type AnalyseInput = {
	asset: string;
	date: string;
	force: boolean;
	runId: string;
	capture: CaptureStepResult | null;
};

export type AnalyseResult = {
	ok: boolean;
	skipped: boolean;
	groundingWarning: boolean;
	error: string | null;
};

export type PrepareResult = {
	ok: boolean;
	skipped: boolean;
	error: string | null;
	requested: string[];
	actual: string[];
	notes: string[];
	hintPoor: boolean;
	started: number;
};

export type ChatStepResult = {
	ok: boolean;
	unusable: boolean;
	error: string | null;
};

export type ParseStepResult = AnalyseResult & {
	needsRetry: boolean;
};

type StoredCompletion = {
	content: string;
	reasoningContent: string | null;
	finishReason: string | null;
	usage: RunRecord["usage"];
};

const EMPTY_COMPLETION: StoredCompletion = {
	content: "",
	reasoningContent: null,
	finishReason: null,
	usage: null,
};

type RunRecord = {
	runId: string;
	asset: string;
	date: string;
	force: boolean;
	timings: { started_at: string; finished_at: string; duration_ms: number };
	usage: Record<string, number | null> | null;
	prompt_cache_hit_tokens: number | null;
	prompt_cache_miss_tokens: number | null;
	reasoning_content: string | null;
	finish_reason: string | null;
	content: string | null;
	errors: string[];
	grounding_warning: boolean;
	unknown_sections: string[];
	requested_timeframes: string[];
	actual_timeframes: string[];
	capture_notes: string[];
	capture_quality: "ok" | "poor" | null;
	keys: string[];
	skipped_analysis: boolean;
};

export async function recordTerminalFailure(env: WorkerEnv, input: AnalyseInput, error: string): Promise<void> {
	const kv = env.CHARTS_CACHE;
	if (!kv) return;
	const requested = input.capture?.requestedTimeframes ?? [...DAILY_TIMEFRAMES];
	const actual = input.capture?.actualTimeframes ?? [];
	const notes = [...(input.capture?.notes ?? [])];
	await writeRun(kv, input, emptyRun(input, Date.now(), requested, actual, notes, false, [error]));
	await notifyFailure(env, { runId: input.runId, asset: input.asset, date: input.date, error });
}

export function correctionText(detail: string): string {
	return `The previous json failed validation: ${detail}\nReturn one corrected json object. No markdown fence.`;
}

export async function prepareAnalysis(env: WorkerEnv, input: AnalyseInput): Promise<PrepareResult> {
	const started = Date.now();
	const kv = env.CHARTS_CACHE;
	if (!kv) throw new AnalysisRequestError("CHARTS_CACHE namespace binding is not configured", false);
	const requested = input.capture?.requestedTimeframes ?? [...DAILY_TIMEFRAMES];
	const notes = [...(input.capture?.notes ?? [])];
	if (!input.force) {
		const existing = await getText(kv, reportJsonKey(input.asset, input.date));
		if (existing) {
			return { ok: true, skipped: true, error: null, requested, actual: [], notes, hintPoor: false, started };
		}
	}
	const loaded = await loadImages(kv, input.asset, input.date, input.capture);
	const actual = loaded.map((image) => image.timeframe);
	if (loaded.length === 0) {
		await fail(env, input, started, requested, actual, notes, EMPTY_COMPLETION, "no screenshots in KV");
		return { ok: false, skipped: false, error: "no screenshots in KV", requested, actual, notes, hintPoor: true, started };
	}
	const tiny = loaded.filter((image) => pngFailsVisibility(image.bytes)).map((image) => image.timeframe);
	if (tiny.length > 0) notes.push(`visibility failed for ${tiny.join(", ")}`);
	const hintPoor = input.capture?.captureQuality === "poor" || loaded.length < 3 || tiny.length > 0;
	return { ok: true, skipped: false, error: null, requested, actual, notes, hintPoor, started };
}

export async function completeAnalysisChat(
	env: WorkerEnv,
	input: AnalyseInput,
	prepared: PrepareResult,
	correction: string | null,
): Promise<ChatStepResult> {
	const kv = env.CHARTS_CACHE;
	if (!kv) throw new AnalysisRequestError("CHARTS_CACHE namespace binding is not configured", false);
	const loaded = await loadModelImages(kv, input.asset, input.date, prepared.actual.length > 0 ? prepared.actual : imageTimeframes(input.capture));
	if (loaded.length === 0) {
		await fail(env, input, prepared.started, prepared.requested, prepared.actual, prepared.notes, EMPTY_COMPLETION, "no screenshots in KV");
		return { ok: false, unusable: false, error: "no screenshots in KV" };
	}
	logEvent("analyse.chat.start", {
		runId: input.runId,
		asset: input.asset,
		date: input.date,
		images: loaded.map((image) => ({ timeframe: image.timeframe, bytes: image.bytes.byteLength, mime: image.mime })),
	});
	const images = loaded.map((image) => ({
		label: isTimeframe(image.timeframe) ? TIMEFRAME_LABELS[image.timeframe] : image.timeframe,
		base64: Buffer.from(image.bytes).toString("base64"),
		timeframe: image.timeframe,
		mime: image.mime,
	}));
	const userContent: UserPart[] = buildUserContent(images, buildRunContext({
		asset: input.asset,
		date: input.date,
		requested: prepared.requested,
		actual: prepared.actual,
		notes: prepared.notes,
	}));
	if (correction) userContent.push({ type: "text", text: correction });
	const completion = await completeChat(env, userContent);
	const stored: StoredCompletion = {
		content: completion.content,
		reasoningContent: completion.reasoningContent,
		finishReason: completion.finishReason,
		usage: completion.usage,
	};
	await putText(kv, completionDraftKey(input.asset, input.date), JSON.stringify(stored));
	const unusable = isUnusableCompletion(completion.content, completion.finishReason);
	return { ok: !unusable, unusable, error: unusable ? "empty or truncated content" : null };
}

export async function recordUnusable(
	env: WorkerEnv,
	input: AnalyseInput,
	prepared: PrepareResult,
	error: string,
): Promise<void> {
	const kv = env.CHARTS_CACHE;
	const stored = kv ? await readCompletion(kv, input.asset, input.date) : null;
	await fail(env, input, prepared.started, prepared.requested, prepared.actual, prepared.notes, stored ?? EMPTY_COMPLETION, error);
	if (kv) await kv.delete(completionDraftKey(input.asset, input.date));
}

export async function persistAnalysis(
	env: WorkerEnv,
	input: AnalyseInput,
	prepared: PrepareResult,
	allowRetry: boolean,
): Promise<ParseStepResult> {
	const kv = env.CHARTS_CACHE;
	if (!kv) throw new AnalysisRequestError("CHARTS_CACHE namespace binding is not configured", false);
	const stored = await readCompletion(kv, input.asset, input.date);
	if (!stored) {
		await fail(env, input, prepared.started, prepared.requested, prepared.actual, prepared.notes, EMPTY_COMPLETION, "missing completion");
		return { ok: false, skipped: false, groundingWarning: false, error: "missing completion", needsRetry: false };
	}
	if (isUnusableCompletion(stored.content, stored.finishReason)) {
		await fail(env, input, prepared.started, prepared.requested, prepared.actual, prepared.notes, stored, "empty or truncated content");
		await kv.delete(completionDraftKey(input.asset, input.date));
		return { ok: false, skipped: false, groundingWarning: false, error: "empty or truncated content", needsRetry: false };
	}
	let analysis: ChartAnalysis;
	try {
		analysis = parseAnalysis(stored.content);
	} catch (error) {
		const detail = validationMessage(error);
		if (allowRetry && isParseError(error)) {
			return { ok: false, skipped: false, groundingWarning: false, error: detail, needsRetry: true };
		}
		await fail(env, input, prepared.started, prepared.requested, prepared.actual, prepared.notes, stored, detail);
		await kv.delete(completionDraftKey(input.asset, input.date));
		return { ok: false, skipped: false, groundingWarning: false, error: detail, needsRetry: false };
	}
	const stamped = stamp(analysis, env, input, prepared.requested, prepared.actual, prepared.notes, prepared.hintPoor);
	const validated = chartAnalysisSchema.parse(stamped);
	const unknown = validated.method_citations.map((item) => item.section).filter((section) => !CITABLE_SECTIONS.includes(section));
	const groundingWarning = validated.capture.capture_quality !== "poor" && validated.method_citations.length === 0;
	const errors = [
		...(groundingWarning ? ["method_citations is empty"] : []),
		...(unknown.length > 0 ? [`unknown method sections: ${unknown.join(", ")}`] : []),
	];
	await putText(kv, reportJsonKey(input.asset, input.date), JSON.stringify(validated));
	await putText(kv, reportMdKey(input.asset, input.date), renderReport(validated));
	await writeRun(kv, input, {
		...emptyRun(input, prepared.started, prepared.requested, prepared.actual, prepared.notes, false, errors),
		usage: stored.usage,
		prompt_cache_hit_tokens: stored.usage?.prompt_cache_hit_tokens ?? null,
		prompt_cache_miss_tokens: stored.usage?.prompt_cache_miss_tokens ?? null,
		reasoning_content: stored.reasoningContent,
		finish_reason: stored.finishReason,
		content: null,
		grounding_warning: groundingWarning,
		unknown_sections: unknown,
		capture_quality: validated.capture.capture_quality,
		keys: prepared.actual.map((timeframe) => screenshotKey(input.asset, timeframe, input.date)),
	});
	await kv.delete(completionDraftKey(input.asset, input.date));
	console.log(JSON.stringify({
		event: "analyse.done",
		runId: input.runId,
		asset: input.asset,
		date: input.date,
		finish_reason: stored.finishReason,
		prompt_cache_hit_tokens: stored.usage?.prompt_cache_hit_tokens ?? null,
		prompt_cache_miss_tokens: stored.usage?.prompt_cache_miss_tokens ?? null,
		grounding_warning: groundingWarning,
	}));
	if (groundingWarning || validated.capture.capture_quality === "poor") {
		await notifyFailure(env, {
			runId: input.runId,
			asset: input.asset,
			date: input.date,
			error: groundingWarning ? "empty method_citations" : "capture_quality poor",
		});
	}
	return { ok: true, skipped: false, groundingWarning, error: null, needsRetry: false };
}

export async function analyseAsset(env: WorkerEnv, input: AnalyseInput): Promise<AnalyseResult> {
	const prepared = await prepareAnalysis(env, input);
	if (!prepared.ok || prepared.skipped) {
		return { ok: prepared.ok, skipped: prepared.skipped, groundingWarning: false, error: prepared.error };
	}
	for (const timeframe of prepared.actual) {
		await compressModelImage(env, input.asset, input.date, timeframe, input.force);
	}
	let chat = await completeAnalysisChat(env, input, prepared, null);
	let retried = false;
	if (chat.unusable) {
		retried = true;
		chat = await completeAnalysisChat(env, input, prepared, null);
		if (chat.unusable) {
			await recordUnusable(env, input, prepared, "empty or truncated content");
			return { ok: false, skipped: false, groundingWarning: false, error: "empty or truncated content" };
		}
	}
	if (!chat.ok) return { ok: false, skipped: false, groundingWarning: false, error: chat.error };
	let parsed = await persistAnalysis(env, input, prepared, !retried);
	if (!parsed.needsRetry) {
		return { ok: parsed.ok, skipped: parsed.skipped, groundingWarning: parsed.groundingWarning, error: parsed.error };
	}
	const corrected = await completeAnalysisChat(env, input, prepared, correctionText(parsed.error ?? "validation failed"));
	if (corrected.unusable) {
		await recordUnusable(env, input, prepared, "retry empty or truncated");
		return { ok: false, skipped: false, groundingWarning: false, error: "retry empty or truncated" };
	}
	if (!corrected.ok) return { ok: false, skipped: false, groundingWarning: false, error: corrected.error };
	parsed = await persistAnalysis(env, input, prepared, false);
	return { ok: parsed.ok, skipped: parsed.skipped, groundingWarning: parsed.groundingWarning, error: parsed.error };
}

async function readCompletion(kv: KVNamespace, asset: string, date: string): Promise<StoredCompletion | null> {
	const text = await getText(kv, completionDraftKey(asset, date));
	if (!text) return null;
	const parsed = JSON.parse(text) as StoredCompletion;
	if (!parsed || typeof parsed.content !== "string") return null;
	return {
		content: parsed.content,
		reasoningContent: parsed.reasoningContent ?? null,
		finishReason: parsed.finishReason ?? null,
		usage: parsed.usage ?? null,
	};
}

function stamp(
	analysis: ChartAnalysis,
	env: WorkerEnv,
	input: AnalyseInput,
	requested: string[],
	actual: string[],
	notes: string[],
	hintPoor: boolean,
): ChartAnalysis {
	const mergedNotes = [notes.join(" ").trim(), analysis.capture.notes].filter(Boolean).join(" ") || null;
	return {
		...analysis,
		schema_version: SCHEMA_VERSION,
		prompt_version: PROMPT_VERSION,
		model: resolveModel(env.DEEPSEEK_MODEL),
		generated_at_utc: new Date().toISOString(),
		asset: input.asset,
		capture: {
			...analysis.capture,
			requested_timeframes: requested,
			actual_timeframes: actual,
			capture_quality: hintPoor || analysis.capture.capture_quality === "poor" ? "poor" : "ok",
			notes: mergedNotes,
		},
	};
}

function imageTimeframes(capture: CaptureStepResult | null): string[] {
	return capture?.frames.filter((frame) => frame.stored).map((frame) => frame.timeframe)
		?? capture?.actualTimeframes
		?? [...DAILY_TIMEFRAMES];
}

async function loadImages(
	kv: KVNamespace,
	asset: string,
	date: string,
	capture: CaptureStepResult | null,
): Promise<{ timeframe: string; bytes: Uint8Array }[]> {
	const timeframes = imageTimeframes(capture);
	const images: { timeframe: string; bytes: Uint8Array }[] = [];
	for (const timeframe of timeframes) {
		const bytes = await getBytes(kv, screenshotKey(asset, timeframe, date));
		if (bytes) images.push({ timeframe, bytes });
	}
	return images;
}

async function fail(
	env: WorkerEnv,
	input: AnalyseInput,
	started: number,
	requested: string[],
	actual: string[],
	notes: string[],
	completion: { content: string; reasoningContent: string | null; finishReason: string | null; usage: RunRecord["usage"] },
	error: string,
): Promise<void> {
	const kv = env.CHARTS_CACHE;
	if (!kv) return;
	await writeRun(kv, input, {
		...emptyRun(input, started, requested, actual, notes, false, [error]),
		usage: completion.usage,
		prompt_cache_hit_tokens: completion.usage?.prompt_cache_hit_tokens ?? null,
		prompt_cache_miss_tokens: completion.usage?.prompt_cache_miss_tokens ?? null,
		reasoning_content: completion.reasoningContent,
		finish_reason: completion.finishReason,
		content: completion.content,
		capture_quality: null,
	});
	await notifyFailure(env, { runId: input.runId, asset: input.asset, date: input.date, error });
}

function emptyRun(
	input: AnalyseInput,
	started: number,
	requested: string[],
	actual: string[],
	notes: string[],
	skipped: boolean,
	errors: string[],
): RunRecord {
	const finished = Date.now();
	return {
		runId: input.runId,
		asset: input.asset,
		date: input.date,
		force: input.force,
		timings: {
			started_at: new Date(started).toISOString(),
			finished_at: new Date(finished).toISOString(),
			duration_ms: finished - started,
		},
		usage: null,
		prompt_cache_hit_tokens: null,
		prompt_cache_miss_tokens: null,
		reasoning_content: null,
		finish_reason: null,
		content: null,
		errors,
		grounding_warning: false,
		unknown_sections: [],
		requested_timeframes: requested,
		actual_timeframes: actual,
		capture_notes: notes,
		capture_quality: input.capture?.captureQuality ?? null,
		keys: actual.map((timeframe) => screenshotKey(input.asset, timeframe, input.date)),
		skipped_analysis: skipped,
	};
}

async function writeRun(kv: KVNamespace, input: AnalyseInput, record: RunRecord): Promise<void> {
	await putText(kv, runKey(input.asset, input.date), JSON.stringify(record));
}

function isParseError(error: unknown): boolean {
	return error instanceof ZodError || error instanceof SyntaxError;
}

function validationMessage(error: unknown): string {
	if (error instanceof Error) return error.message.slice(0, 2000);
	return "unknown validation error";
}
