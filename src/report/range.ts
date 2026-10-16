import type { ChartAnalysis } from "../analysis/schema";

export type RangeRead = {
	low: number;
	high: number;
	equilibrium: number;
	close: number;
	side: "discount" | "premium" | "equilibrium";
};

export function extractRange(analysis: ChartAnalysis): RangeRead | null {
	const text = [
		analysis.bias.rationale,
		analysis.verdict.reason,
		...analysis.timeframes.flatMap((frame) => [frame.structure, frame.notes, ...frame.levels]),
	]
		.filter(Boolean)
		.join("\n");
	const span = text.match(/range\s+~?([\d,]+(?:\.\d+)?)\s*[–-]\s*~?([\d,]+(?:\.\d+)?)/i);
	const spanNumbers = span ? [price(span[1] ?? ""), price(span[2] ?? "")].filter((value): value is number => value !== null) : [];
	const high = firstPrice(text, [
		/external range high(?:\s*\(est\.\))?\s+~?([\d,]+(?:\.\d+)?)/i,
		/range high(?:\s*\(est\.\))?\s+~?([\d,]+(?:\.\d+)?)/i,
	]) ?? (spanNumbers.length === 2 ? Math.max(...spanNumbers) : null);
	const low = firstPrice(text, [
		/external range low(?:\s*\(est\.\))?\s+~?([\d,]+(?:\.\d+)?)/i,
		/range low(?:\s*\(est\.\))?\s+~?([\d,]+(?:\.\d+)?)/i,
	]) ?? firstPrice(text, [/\blow\s+~?([\d,]+(?:\.\d+)?)/i]) ?? (spanNumbers.length === 2 ? Math.min(...spanNumbers) : null);
	const equilibrium = firstPrice(text, [/equilibrium(?:\s+of\s+external\s+range)?(?:\s*\(est\.\))?\s+~?([\d,]+(?:\.\d+)?)/i]);
	const close = firstPrice(text, [
		/last daily close\s+~?([\d,]+(?:\.\d+)?)/i,
		/current daily close\s+~?([\d,]+(?:\.\d+)?)/i,
		/current close\s+~?([\d,]+(?:\.\d+)?)/i,
		/daily close\s+~?([\d,]+(?:\.\d+)?)/i,
	]);
	if (high === null || low === null || equilibrium === null || close === null || !(high > low)) return null;
	const side = close < equilibrium ? "discount" : close > equilibrium ? "premium" : "equilibrium";
	return { low, high, equilibrium, close, side };
}

export function formatPrice(value: number): string {
	const digits = Number.isInteger(value) ? 0 : 2;
	return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function rangePercent(value: number, low: number, high: number): number {
	if (!(high > low)) return 0;
	return Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
}

function firstPrice(text: string, patterns: RegExp[]): number | null {
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const value = price(match?.[1] ?? "");
		if (value !== null) return value;
	}
	return null;
}

function price(raw: string): number | null {
	if (!raw) return null;
	const value = Number(raw.replace(/,/g, ""));
	return Number.isFinite(value) && value > 0 ? value : null;
}
