import { SYSTEM_PROMPT } from "./prompt";
import { REASONING_CAP, capReasoningPayload } from "./reasoning";
import { buildChatRequest, type UserPart } from "./request";
import type { WorkerEnv } from "../env";

const CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const ALLOWED_MODEL = "deepseek-flash";
const RETIRED_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"]);

export class AnalysisRequestError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "AnalysisRequestError";
		this.retryable = retryable;
	}
}

export type CompletionResult = {
	content: string;
	reasoningContent: string | null;
	finishReason: string | null;
	usage: {
		prompt_tokens: number | null;
		completion_tokens: number | null;
		total_tokens: number | null;
		prompt_cache_hit_tokens: number | null;
		prompt_cache_miss_tokens: number | null;
	};
};

type ApiResponse = {
	choices?: Array<{
		finish_reason?: string | null;
		message?: {
			content?: string | null;
			reasoning_content?: string | null;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
	};
};

export function resolveModel(configured: string | undefined): string {
	const model = configured?.trim() || ALLOWED_MODEL;
	if (RETIRED_MODELS.has(model) || model !== ALLOWED_MODEL) {
		throw new AnalysisRequestError(`Refusing model ${model}. DEEPSEEK_MODEL must be deepseek-flash.`, false);
	}
	return model;
}

export function resolveEffort(configured: string | undefined): "low" | "high" | "max" {
	const value = configured?.trim() || "high";
	if (value === "medium") return "high";
	if (value === "low" || value === "high" || value === "max") return value;
	return "high";
}

export async function completeChat(env: WorkerEnv, userContent: UserPart[]): Promise<CompletionResult> {
	const apiKey = env.DEEPSEEK_API_KEY;
	if (!apiKey) throw new AnalysisRequestError("DEEPSEEK_API_KEY is not configured", false);
	const body = buildChatRequest({
		model: resolveModel(env.DEEPSEEK_MODEL),
		effort: resolveEffort(env.DEEPSEEK_REASONING_EFFORT),
		systemPrompt: SYSTEM_PROMPT,
		userContent,
	});
	let response: Response;
	try {
		response = await fetch(CHAT_COMPLETIONS_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new AnalysisRequestError(error instanceof Error ? error.message : "DeepSeek request failed", true);
	}
	if (!response.ok) {
		const text = await response.text();
		throw new AnalysisRequestError(
			`DeepSeek ${response.status}: ${text.slice(0, 500)}`,
			response.status === 429 || response.status >= 500,
		);
	}
	const raw = await response.text();
	const payload = parseCompletion(raw);
	const choice = payload.choices?.[0];
	return {
		content: choice?.message?.content ?? "",
		reasoningContent: choice?.message?.reasoning_content ?? null,
		finishReason: choice?.finish_reason ?? null,
		usage: {
			prompt_tokens: payload.usage?.prompt_tokens ?? null,
			completion_tokens: payload.usage?.completion_tokens ?? null,
			total_tokens: payload.usage?.total_tokens ?? null,
			prompt_cache_hit_tokens: payload.usage?.prompt_cache_hit_tokens ?? null,
			prompt_cache_miss_tokens: payload.usage?.prompt_cache_miss_tokens ?? null,
		},
	};
}

function parseCompletion(raw: string): ApiResponse {
	let payload: ApiResponse;
	try {
		payload = JSON.parse(capReasoningPayload(raw)) as ApiResponse;
	} catch {
		payload = JSON.parse(raw) as ApiResponse;
	}
	const message = payload.choices?.[0]?.message;
	if (message?.reasoning_content && message.reasoning_content.length > REASONING_CAP) {
		message.reasoning_content = message.reasoning_content.slice(0, REASONING_CAP);
	}
	return payload;
}
