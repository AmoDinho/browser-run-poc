import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chartAnalysisSchema, EXAMPLE_ANALYSIS, exampleJson } from "../src/analysis/schema";
import { extractJson, isUnusableCompletion, parseAnalysis } from "../src/analysis/parse";
import { buildChatRequest, buildUserContent } from "../src/analysis/request";
import { markdownH2 } from "../src/analysis/sections";
import { isFatalCaptureMessage, mergeCaptureResults, missedCapture, shouldRetryCapture } from "../src/capture/browser";
import { isChartBoxVisible, pngSize } from "../src/capture/visibility";
import { intervalLabelMatches, isDuplicateHash, resolveTimeframeChoice, sha256Hex } from "../src/capture/verify";
import { markdownToHtml } from "../src/report/html";
import { DISCLAIMER, renderReport } from "../src/report/render";
import { normalizeParams } from "../src/workflow-params";
import type { ChartAnalysis } from "../src/analysis/schema";

const tinyPng = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
]);

test("rejects a deliberately tiny chart image", () => {
	assert.deepEqual(pngSize(tinyPng), { width: 1, height: 1 });
	assert.equal(isChartBoxVisible(pngSize(tinyPng)), false);
	assert.equal(isChartBoxVisible({ width: 600, height: 300 }), true);
	assert.equal(isChartBoxVisible({ width: 599, height: 400 }), false);
});

test("does not accept a repeated screenshot hash", () => {
	assert.equal(isDuplicateHash("abc", ["abc"]), true);
	assert.equal(isDuplicateHash("def", ["abc"]), false);
});

test("hashes a byte view without the surrounding buffer", async () => {
	const packed = new Uint8Array([1, 2, 3, 4, 5]);
	const view = packed.subarray(1, 4);
	const exact = new Uint8Array([2, 3, 4]);
	assert.equal(await sha256Hex(view), await sha256Hex(exact));
	assert.notEqual(await sha256Hex(view), await sha256Hex(packed));
});

test("merges per-timeframe captures and does not retry a duplicate miss", () => {
	const merged = mergeCaptureResults("gold", "2026-10-12", ["1D", "30m"], [
		{
			asset: "gold",
			date: "2026-10-12",
			requestedTimeframes: ["1D"],
			actualTimeframes: ["1D"],
			frames: [
				{
					timeframe: "1D",
					label: "1 day",
					key: "gold/1D/2026-10-12.png",
					hash: "abc",
					width: 800,
					height: 400,
					intervalVerified: true,
					stored: true,
					note: null,
				},
			],
			notes: [],
			skipped: false,
			captureQuality: "ok",
		},
		missedCapture("gold", "2026-10-12", "30m", "duplicate hash"),
	]);
	assert.deepEqual(merged.actualTimeframes, ["1D"]);
	assert.equal(merged.captureQuality, "poor");
	assert.equal(merged.skipped, false);
	assert.equal(shouldRetryCapture(missedCapture("gold", "2026-10-12", "30m", "duplicate hash")), false);
	assert.equal(shouldRetryCapture(missedCapture("gold", "2026-10-12", "30m", "chart box missing")), true);
	assert.equal(isFatalCaptureMessage("Daily time limit exceeded"), true);
	assert.equal(isFatalCaptureMessage("chart box missing"), false);
});

test("falls back from 3h to 30m only when the label is absent and unused", () => {
	const fallen = resolveTimeframeChoice("3h", ["1 day", "30 minutes"], []);
	assert.equal(fallen?.timeframe, "30m");
	assert.match(fallen?.note ?? "", /absent/);
	assert.equal(resolveTimeframeChoice("3h", ["1 day", "30 minutes"], ["30m"]), null);
	assert.equal(resolveTimeframeChoice("3h", ["1 day", "3 hours", "30 minutes"], [])?.timeframe, "3h");
});

test("matches the interval button readback", () => {
	assert.equal(intervalLabelMatches("1D | Chart interval", "1D", "1 day"), true);
	assert.equal(intervalLabelMatches("30 | Chart interval", "3h", "3 hours"), false);
	assert.equal(intervalLabelMatches("3 hours | Chart interval", "3h", "3 hours"), true);
	assert.equal(intervalLabelMatches("1 day | 1D | D | 1D", "1D", "1 day"), true);
	assert.equal(intervalLabelMatches("3 hours | 180 | 3h | 3h", "3h", "3 hours"), true);
	assert.equal(intervalLabelMatches("30 minutes | 30 | 30m | 30m", "30m", "30 minutes"), true);
	assert.equal(intervalLabelMatches("| | Chart interval", "1D", "1 day"), false);
	assert.equal(intervalLabelMatches("5 minutes | 5 | 5m | 5", "1D", "1 day"), false);
	assert.equal(intervalLabelMatches("30 minutes | 30 | 30m | 30m", "3h", "3 hours"), false);
});

test("schema example is the only json shape", () => {
	const parsed = chartAnalysisSchema.parse(JSON.parse(exampleJson()));
	assert.equal(parsed.asset, "example");
	assert.throws(() => chartAnalysisSchema.parse({ ...EXAMPLE_ANALYSIS, bias: { ...EXAMPLE_ANALYSIS.bias, direction: "buy" } }));
	const { notes: _notes, ...capture } = EXAMPLE_ANALYSIS.capture;
	assert.throws(() => chartAnalysisSchema.parse({ ...EXAMPLE_ANALYSIS, capture }));
});

test("treats empty and truncated completions as failures", () => {
	assert.equal(isUnusableCompletion("", "stop"), true);
	assert.equal(isUnusableCompletion("{}", "length"), true);
	assert.equal(isUnusableCompletion("{}", "stop"), false);
	assert.equal(parseAnalysis("```json\n" + exampleJson() + "\n```").asset, "example");
	assert.throws(() => parseAnalysis("{"));
	assert.equal(extractJson("```json\n{\"a\":1}\n```"), "{\"a\":1}");
});

test("chat request is json_object chat completions, not a schema", () => {
	const user = buildUserContent(
		[{ label: "1 day", base64: "abc" }],
		"Asset: gold\nUTC date: 2026-10-12",
	);
	const body = buildChatRequest({
		model: "deepseek-flash",
		effort: "high",
		systemPrompt: "methodology text only. Output json.",
		userContent: user,
	});
	const wire = JSON.stringify(body);
	assert.equal(body.response_format.type, "json_object");
	assert.equal(body.thinking.type, "enabled");
	assert.equal(body.max_tokens, 16384);
	assert.equal(typeof body.messages[0].content, "string");
	assert.equal(body.messages[1].content.at(-1)?.type, "text");
	assert.equal(body.messages[1].content[1]?.type, "image_url");
	if (body.messages[1].content[1]?.type === "image_url") {
		assert.equal(body.messages[1].content[1].image_url.detail, "original");
	}
	assert.equal(wire.includes("temperature"), false);
	assert.equal(wire.includes("json_schema"), false);
	assert.equal(wire.includes("\"tools\""), false);
	assert.equal(wire.includes("image_url"), true);
});

test("poor capture suppresses bias and a blank-image report is not advice", () => {
	const poor = analysis({ capture_quality: "poor", citations: [] });
	const rendered = renderReport(poor);
	assert.match(rendered, /Capture warning/);
	assert.equal(rendered.includes("## Bias"), false);
	assert.equal(rendered.includes("Grounding warning"), false);
	assert.match(rendered, new RegExp(DISCLAIMER));
	assert.equal(/\bbuy\b|\bsell\b/i.test(rendered), false);
});

test("empty citations warn only when capture is ok", () => {
	const ok = renderReport(analysis({ capture_quality: "ok", citations: [] }));
	assert.match(ok, /Grounding warning/);
	assert.match(ok, /## Bias/);
	const cited = renderReport(analysis({ capture_quality: "ok", citations: [{ claim: "context first", section: "Order of work" }] }));
	assert.equal(cited.includes("Grounding warning"), false);
});

test("report html escapes model text", () => {
	const html = markdownToHtml("Rationale: <script>alert(1)</script>", "/reports/gold/2026-10-12", "a&b");
	assert.equal(html.includes("<script>"), false);
	assert.match(html, /&lt;script&gt;/);
});

test("cron cannot force a re-run", () => {
	const params = normalizeParams({
		date: "2026-10-12",
		force: true,
		assets: ["nasdaq100", "gold"],
		phase: "full",
		runId: "cron-2026-10-12",
	});
	assert.equal(params.force, false);
	const manual = normalizeParams({
		date: "2026-10-12",
		force: true,
		assets: ["gold"],
		phase: "analyse",
		runId: "analyse-2026-10-12-1",
	});
	assert.equal(manual.force, true);
});

test("decision procedure and reference context are separate files", () => {
	const method = readFileSync(new URL("../knowledge/methodology.md", import.meta.url), "utf8");
	const context = readFileSync(new URL("../knowledge/context.md", import.meta.url), "utf8");
	const prompt = readFileSync(new URL("../src/analysis/prompt.ts", import.meta.url), "utf8");
	const client = readFileSync(new URL("../src/analysis/client.ts", import.meta.url), "utf8");
	assert.match(method, /stand aside/);
	assert.match(context, /stored separately/);
	assert.equal(method.includes("Pin bar or hammer"), false);
	assert.deepEqual(markdownH2(method), [
		"Inputs",
		"Ground rules",
		"HTF bias and dealing range",
		"ITF phase and alignment",
		"STF sessions liquidity and traps",
		"ETF inducement and confirmation",
		"Trade plan",
		"Final verdict",
	]);
	assert.match(prompt, /knowledge\/methodology\.md/);
	assert.match(prompt, /knowledge\/context\.md/);
	assert.match(prompt, /json/);
	assert.equal(client.includes("temperature"), false);
	assert.equal(client.includes("/chat/completions"), true);
	assert.equal(client.includes("file_search"), false);
});

function analysis(input: { capture_quality: "ok" | "poor"; citations: ChartAnalysis["method_citations"] }): ChartAnalysis {
	return {
		...EXAMPLE_ANALYSIS,
		asset: "gold",
		capture: { ...EXAMPLE_ANALYSIS.capture, capture_quality: input.capture_quality, notes: "tiny image" },
		bias: { direction: "up", timeframe_agreement: "aligned", rationale: "higher highs on the daily" },
		method_citations: input.citations,
	};
}
