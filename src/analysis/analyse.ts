import { Buffer } from "node:buffer";
import { ZodError } from "zod";
import { DAILY_TIMEFRAMES, TIMEFRAME_LABELS, isTimeframe } from "../capture/config";
import { pngFailsVisibility } from "../capture/visibility";
import type { CaptureStepResult } from "../capture/browser";
import type { WorkerEnv } from "../env";
import { notifyFailure } from "../notify";
import { renderReport } from "../report/render";
import { getBytes, getText, putText, reportJsonKey, reportMdKey, runKey, screenshotKey } from "../storage/kv";
import { AnalysisRequestError, completeChat, resolveModel } from "./client";
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

export async function analyseAsset(env: WorkerEnv, input: AnalyseInput): Promise<AnalyseResult> {
	const started = Date.now();
	const kv = env.CHARTS_CACHE;
	if (!kv) throw new AnalysisRequestError("CHARTS_CACHE namespace binding is not configured", false);
	const requested = input.capture?.requestedTimeframes ?? [...DAILY_TIMEFRAMES];
	const notes = [...(input.capture?.notes ?? [])];
	if (!input.force) {
		const existing = await getText(kv, reportJsonKey(input.asset, input.date));
		if (existing) return { ok: true, skipped: true, groundingWarning: false, error: null };
	}
	const loaded = await loadImages(kv, input.asset, input.date, input.capture);
	const actual = loaded.map((image) => image.timeframe);
	if (loaded.length === 0) {
		const record = emptyRun(input, started, requested, actual, notes, false, ["no screenshots in KV"]);
		await writeRun(kv, input, record);
		await notifyFailure(env, { runId: input.runId, asset: input.asset, date: input.date, error: "no screenshots in KV" });
		return { ok: false, skipped: false, groundingWarning: false, error: "no screenshots in KV" };
	}
	const tiny = loaded.filter((image) => pngFailsVisibility(image.bytes)).map((image) => image.timeframe);
	if (tiny.length > 0) notes.push(`visibility failed for ${tiny.join(", ")}`);
	const hintPoor = input.capture?.captureQuality === "poor" || loaded.length < 3 || tiny.length > 0;
	const images = loaded.map((image) => ({
		label: isTimeframe(image.timeframe) ? TIMEFRAME_LABELS[image.timeframe] : image.timeframe,
		base64: Buffer.from(image.bytes).toString("base64"),
		timeframe: image.timeframe,
	}));
	const userContent = buildUserContent(images, buildRunContext({
		asset: input.asset,
		date: input.date,
		requested,
		actual,
		notes,
	}));
	let retried = false;
	let completion = await completeChat(env, userContent);
	if (isUnusableCompletion(completion.content, completion.finishReason)) {
		retried = true;
		completion = await completeChat(env, userContent);
		if (isUnusableCompletion(completion.content, completion.finishReason)) {
			await fail(env, input, started, requested, actual, notes, completion, "empty or truncated content");
			return { ok: false, skipped: false, groundingWarning: false, error: "empty or truncated content" };
		}
	}
	let analysis: ChartAnalysis;
	try {
		analysis = parseAnalysis(completion.content);
	} catch (error) {
		if (retried || !isParseError(error)) {
			const detail = validationMessage(error);
			await fail(env, input, started, requested, actual, notes, completion, detail);
			return { ok: false, skipped: false, groundingWarning: false, error: detail };
		}
		retried = true;
		const retryContent: UserPart[] = [
			...userContent,
			{ type: "text", text: `The previous json failed validation: ${validationMessage(error)}\nReturn one corrected json object. No markdown fence.` },
		];
		completion = await completeChat(env, retryContent);
		if (isUnusableCompletion(completion.content, completion.finishReason)) {
			await fail(env, input, started, requested, actual, notes, completion, "retry empty or truncated");
			return { ok: false, skipped: false, groundingWarning: false, error: "retry empty or truncated" };
		}
		try {
			analysis = parseAnalysis(completion.content);
		} catch (retryError) {
			const detail = validationMessage(retryError);
			await fail(env, input, started, requested, actual, notes, completion, detail);
			return { ok: false, skipped: false, groundingWarning: false, error: detail };
		}
	}
	const stamped = stamp(analysis, env, input, requested, actual, notes, hintPoor);
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
		...emptyRun(input, started, requested, actual, notes, false, errors),
		usage: completion.usage,
		prompt_cache_hit_tokens: completion.usage.prompt_cache_hit_tokens,
		prompt_cache_miss_tokens: completion.usage.prompt_cache_miss_tokens,
		reasoning_content: completion.reasoningContent,
		finish_reason: completion.finishReason,
		content: null,
		grounding_warning: groundingWarning,
		unknown_sections: unknown,
		capture_quality: validated.capture.capture_quality,
		keys: actual.map((timeframe) => screenshotKey(input.asset, timeframe, input.date)),
	});
	console.log(JSON.stringify({
		event: "analyse.done",
		runId: input.runId,
		asset: input.asset,
		date: input.date,
		finish_reason: completion.finishReason,
		prompt_cache_hit_tokens: completion.usage.prompt_cache_hit_tokens,
		prompt_cache_miss_tokens: completion.usage.prompt_cache_miss_tokens,
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
	return { ok: true, skipped: false, groundingWarning, error: null };
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

async function loadImages(
	kv: KVNamespace,
	asset: string,
	date: string,
	capture: CaptureStepResult | null,
): Promise<{ timeframe: string; bytes: Uint8Array }[]> {
	const timeframes = capture?.frames.filter((frame) => frame.stored).map((frame) => frame.timeframe)
		?? capture?.actualTimeframes
		?? [...DAILY_TIMEFRAMES];
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
