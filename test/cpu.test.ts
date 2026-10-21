import assert from "node:assert/strict";
import test from "node:test";
import { buildUserContent } from "../src/analysis/request";
import { capReasoningPayload } from "../src/analysis/reasoning";
import { shouldAbortRequest } from "../src/capture/requests";
import { assetForCron, instanceId, runIdFor } from "../src/workflow-params";

test("blocks ads, third-party fonts, and media without touching the chart", () => {
	assert.equal(shouldAbortRequest("https://www.livecharts.co.uk/MarketCharts/gold.php", "document"), false);
	assert.equal(shouldAbortRequest("https://s.tradingview.com/widgetembed/?symbol=XAUUSD", "script"), false);
	assert.equal(shouldAbortRequest("https://s.tradingview.com/static/bundles/font.woff2", "font"), false);
	assert.equal(shouldAbortRequest("https://fonts.googleapis.com/css?family=Roboto", "stylesheet"), true);
	assert.equal(shouldAbortRequest("https://www.google-analytics.com/collect", "script"), true);
	assert.equal(shouldAbortRequest("https://cdn.example.com/ad.mp4", "media"), true);
	assert.equal(shouldAbortRequest("https://cdn.example.com/app.js", "script"), false);
});

test("caps reasoning before the completion is parsed", () => {
	const raw = JSON.stringify({
		choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}", reasoning_content: `say "hi" ${"y".repeat(40)}` } }],
		usage: { prompt_tokens: 3 },
	});
	const capped = capReasoningPayload(raw, 12);
	const parsed = JSON.parse(capped) as { choices: Array<{ message: { content: string; reasoning_content: string } }> };
	assert.equal(parsed.choices[0]?.message.content, "{\"ok\":true}");
	assert.equal(parsed.choices[0]?.message.reasoning_content, `say "hi" yyy`);
	assert.equal(capReasoningPayload(JSON.stringify({ choices: [{ message: { reasoning_content: "short" } }] }), 12).includes("short"), true);
});

test("model images can be jpeg without changing the stored png contract", () => {
	const parts = buildUserContent([{ label: "1 day", base64: "abc", mime: "image/jpeg" }], "Asset: gold");
	const image = parts[1];
	assert.equal(image?.type, "image_url");
	if (image?.type === "image_url") assert.equal(image.image_url.url, "data:image/jpeg;base64,abc");
});

test("each asset has its own cron instance", () => {
	assert.equal(assetForCron("0 7 * * 1-5"), "nasdaq100");
	assert.equal(assetForCron("10 7 * * MON-FRI"), "gold");
	assert.equal(assetForCron("15 7 * * 1-5"), null);
	const nasdaq = {
		date: "2026-10-12",
		force: false,
		assets: ["nasdaq100" as const],
		phase: "full" as const,
		runId: runIdFor("full", "2026-10-12", false, "nasdaq100"),
	};
	const gold = { ...nasdaq, assets: ["gold" as const], runId: runIdFor("full", "2026-10-12", false, "gold") };
	assert.equal(instanceId(nasdaq), "cron-nasdaq100-2026-10-12");
	assert.equal(instanceId(gold), "cron-gold-2026-10-12");
	assert.notEqual(instanceId(nasdaq), instanceId(gold));
});
