import type { ChartAnalysis } from "../analysis/schema";

export const DISCLAIMER =
	"Automatically generated commentary from a model reading images and a written method; not investment advice; not verified against price data.";

export function renderReport(analysis: ChartAnalysis): string {
	const lines: string[] = [`# ${analysis.asset}`, ""];
	if (analysis.capture.capture_quality === "poor") {
		const note = analysis.capture.notes ? ` ${analysis.capture.notes}` : "";
		lines.push(`> **Capture warning:** chart capture quality is poor. Bias and trade plan are withheld.${note}`, "");
	} else if (analysis.method_citations.length === 0) {
		lines.push("> **Grounding warning:** method_citations is empty. The model did not cite the methodology.", "");
	}
	for (const timeframe of analysis.capture.actual_timeframes) {
		lines.push(`![${timeframe}](./${timeframe}.png)`, "");
	}
	if (analysis.capture.capture_quality !== "poor") {
		lines.push("## Bias", "", `Direction: ${analysis.bias.direction}`);
		if (analysis.bias.timeframe_agreement) lines.push(`Agreement: ${analysis.bias.timeframe_agreement}`);
		if (analysis.bias.rationale) lines.push(`Rationale: ${analysis.bias.rationale}`);
		lines.push("");
		lines.push("## Verdict", "");
		lines.push(`${analysis.asset} | ${analysis.verdict.direction} | ${analysis.verdict.grade}`);
		lines.push(`Entry: ${analysis.verdict.entry ?? "NOT VISIBLE"}`);
		lines.push(`Stop: ${analysis.verdict.stop ?? "NOT VISIBLE"} (buffer: ${analysis.verdict.stop_buffer ?? "NOT VISIBLE"})`);
		lines.push(
			`T1: ${analysis.verdict.t1 ?? "NOT VISIBLE"} (${analysis.verdict.t1_rr ?? "n/a"}) | T2: ${analysis.verdict.t2 ?? "NOT VISIBLE"} (${analysis.verdict.t2_rr ?? "n/a"}) | T3: ${analysis.verdict.t3 ?? "NOT VISIBLE"} (${analysis.verdict.t3_rr ?? "n/a"})`,
		);
		lines.push(`Risk: ${analysis.verdict.risk_percent ?? "NOT VISIBLE"}`);
		const passed = analysis.verdict.checklist.filter((item) => item.result === "PASS").length;
		lines.push(`Checklist: ${passed}/${analysis.verdict.checklist.length} PASS`);
		if (analysis.verdict.reason) lines.push(analysis.verdict.reason);
		lines.push("");
		lines.push(bullets(analysis.verdict.checklist.map((item) => `${item.result}: ${item.item}`)));
		lines.push("");
	}
	lines.push("## Timeframes", "");
	if (analysis.timeframes.length === 0) lines.push("None recorded.", "");
	for (const frame of analysis.timeframes) {
		lines.push(`### ${frame.timeframe}`, "");
		if (frame.structure) lines.push(frame.structure);
		if (frame.levels.length > 0) lines.push(`Levels: ${frame.levels.join("; ")}`);
		if (frame.wick_extremes) lines.push(`Wick extremes: ${frame.wick_extremes}`);
		if (frame.notes) lines.push(frame.notes);
		lines.push("");
	}
	lines.push("## Confluence", "", bullets(analysis.confluence.map((item) => `${item.claim} (${item.timeframes.join(", ")})`)), "");
	lines.push("## Conflicts", "", bullets(analysis.conflicts.map((item) => `${item.claim} (${item.timeframes.join(", ")})`)), "");
	lines.push(
		"## Invalidation",
		"",
		bullets(analysis.invalidation.map((item) => (item.level ? `${item.condition} (${item.level})` : item.condition))),
		"",
	);
	lines.push("## Method citations", "", bullets(analysis.method_citations.map((item) => `${item.claim} — ${item.section}`)), "");
	lines.push("## Confidence", "", analysis.confidence, "");
	lines.push("## Caveats", "", bullets(analysis.caveats), "");
	lines.push("## Capture", "");
	lines.push(`Requested: ${analysis.capture.requested_timeframes.join(", ") || "none"}`);
	lines.push(`Actual: ${analysis.capture.actual_timeframes.join(", ") || "none"}`);
	lines.push(`Quality: ${analysis.capture.capture_quality}`);
	if (analysis.capture.notes && analysis.capture.capture_quality !== "poor") lines.push(analysis.capture.notes);
	lines.push("");
	lines.push(`Model: ${analysis.model}`);
	lines.push(`Prompt version: ${analysis.prompt_version}`);
	lines.push(`Schema version: ${analysis.schema_version}`);
	lines.push(`Generated: ${analysis.generated_at_utc}`);
	lines.push("", "---", "", DISCLAIMER, "");
	return lines.join("\n");
}

function bullets(items: string[]): string {
	if (items.length === 0) return "None.";
	return items.map((item) => `- ${item}`).join("\n");
}
