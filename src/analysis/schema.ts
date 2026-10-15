import { z } from "zod";

export const SCHEMA_VERSION = "2";

const directionSchema = z.enum(["up", "down", "mixed", "unclear", "bullish", "bearish", "neutral"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);
const captureQualitySchema = z.enum(["ok", "poor"]);
const checkSchema = z.enum(["PASS", "FAIL", "NOT VISIBLE"]);

export const chartAnalysisSchema = z.object({
	schema_version: z.string(),
	prompt_version: z.string(),
	model: z.string(),
	generated_at_utc: z.string(),
	asset: z.string(),
	capture: z.object({
		requested_timeframes: z.array(z.string()),
		actual_timeframes: z.array(z.string()),
		capture_quality: captureQualitySchema,
		notes: z.string().nullable(),
	}),
	bias: z.object({
		direction: directionSchema,
		timeframe_agreement: z.string().nullable(),
		rationale: z.string().nullable(),
	}),
	timeframes: z.array(
		z.object({
			timeframe: z.string(),
			structure: z.string().nullable(),
			levels: z.array(z.string()),
			wick_extremes: z.string().nullable(),
			notes: z.string().nullable(),
		}),
	),
	confluence: z.array(
		z.object({
			claim: z.string(),
			timeframes: z.array(z.string()),
		}),
	),
	conflicts: z.array(
		z.object({
			claim: z.string(),
			timeframes: z.array(z.string()),
		}),
	),
	invalidation: z.array(
		z.object({
			condition: z.string(),
			level: z.string().nullable(),
		}),
	),
	method_citations: z.array(
		z.object({
			claim: z.string(),
			section: z.string(),
		}),
	),
	verdict: z.object({
		direction: z.enum(["long", "short", "stand_aside"]),
		grade: z.enum(["A+", "B", "NO TRADE"]),
		entry: z.string().nullable(),
		stop: z.string().nullable(),
		stop_buffer: z.string().nullable(),
		t1: z.string().nullable(),
		t1_rr: z.string().nullable(),
		t2: z.string().nullable(),
		t2_rr: z.string().nullable(),
		t3: z.string().nullable(),
		t3_rr: z.string().nullable(),
		risk_percent: z.string().nullable(),
		checklist: z.array(
			z.object({
				item: z.string(),
				result: checkSchema,
			}),
		),
		reason: z.string().nullable(),
	}),
	confidence: confidenceSchema,
	caveats: z.array(z.string()),
});

export type ChartAnalysis = z.infer<typeof chartAnalysisSchema>;

export const EXAMPLE_ANALYSIS: ChartAnalysis = {
	schema_version: SCHEMA_VERSION,
	prompt_version: "2",
	model: "deepseek-flash",
	generated_at_utc: "2020-01-01T00:00:00.000Z",
	asset: "example",
	capture: {
		requested_timeframes: ["1D", "30m", "3h"],
		actual_timeframes: ["1D", "30m", "3h"],
		capture_quality: "ok",
		notes: null,
	},
	bias: {
		direction: "unclear",
		timeframe_agreement: null,
		rationale: null,
	},
	timeframes: [
		{
			timeframe: "1D",
			structure: null,
			levels: [],
			wick_extremes: null,
			notes: null,
		},
	],
	confluence: [],
	conflicts: [],
	invalidation: [],
	method_citations: [{ claim: "shape fixture, not a chart read", section: "Ground rules" }],
	verdict: {
		direction: "stand_aside",
		grade: "NO TRADE",
		entry: null,
		stop: null,
		stop_buffer: null,
		t1: null,
		t1_rr: null,
		t2: null,
		t2_rr: null,
		t3: null,
		t3_rr: null,
		risk_percent: null,
		checklist: [{ item: "HTF bias clear", result: "NOT VISIBLE" }],
		reason: null,
	},
	confidence: "low",
	caveats: [],
};

chartAnalysisSchema.parse(EXAMPLE_ANALYSIS);

export function exampleJson(): string {
	return JSON.stringify(chartAnalysisSchema.parse(EXAMPLE_ANALYSIS), null, 2);
}
