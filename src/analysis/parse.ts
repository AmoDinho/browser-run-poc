import { coerceAnalysis } from "./coerce";
import { chartAnalysisSchema, type ChartAnalysis } from "./schema";

export function isUnusableCompletion(content: string, finishReason: string | null): boolean {
	return content.trim() === "" || finishReason === "length";
}

export function extractJson(content: string): string {
	const trimmed = content.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
	return fenced?.[1]?.trim() ?? trimmed;
}

export function parseAnalysis(content: string): ChartAnalysis {
	const text = extractJson(content);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) throw error;
		throw new SyntaxError(error instanceof Error ? error.message : "Invalid json");
	}
	return chartAnalysisSchema.parse(coerceAnalysis(parsed));
}
