import assert from "node:assert/strict";
import test from "node:test";
import { parseAnalysis } from "../src/analysis/parse";
import { EXAMPLE_ANALYSIS } from "../src/analysis/schema";
import { isMorningPing, morningDigest, morningHeading } from "../src/notify";
import { renderBrief } from "../src/report/brief";
import { extractRange } from "../src/report/range";

test("coerces a partial capture and string lists into the schema", () => {
	const broken = {
		...EXAMPLE_ANALYSIS,
		capture: { ...EXAMPLE_ANALYSIS.capture, capture_quality: "partial" },
		confluence: ["daily lower highs"],
		conflicts: ["daily down, 30m up"],
		invalidation: ["close above 4220"],
	};
	const parsed = parseAnalysis(JSON.stringify(broken));
	assert.equal(parsed.capture.capture_quality, "poor");
	assert.equal(parsed.confluence[0]?.claim, "daily lower highs");
	assert.deepEqual(parsed.confluence[0]?.timeframes, []);
	assert.equal(parsed.conflicts[0]?.claim, "daily down, 30m up");
	assert.equal(parsed.invalidation[0]?.condition, "close above 4220");
	assert.equal(parsed.invalidation[0]?.level, null);
});

test("reads the dealing range from the bias text", () => {
	const analysis = {
		...EXAMPLE_ANALYSIS,
		bias: {
			direction: "bearish" as const,
			timeframe_agreement: "conflict: 1D bearish vs 3h/30m bounce",
			rationale: "External dealing range high 4,650 (est.), low 4,050 (est.); equilibrium ~4,350 (est.). Last daily close 4,191.15 is below equilibrium.",
		},
		verdict: {
			...EXAMPLE_ANALYSIS.verdict,
			reason: "Stand aside. Price is in discount.",
			checklist: [
				{ item: "HTF bias is clear", result: "FAIL" as const },
				{ item: "Qualified POI", result: "FAIL" as const },
				{ item: "ITF phase", result: "NOT VISIBLE" as const },
			],
		},
	};
	const range = extractRange(analysis);
	assert.equal(range?.high, 4650);
	assert.equal(range?.low, 4050);
	assert.equal(range?.equilibrium, 4350);
	assert.equal(range?.close, 4191.15);
	assert.equal(range?.side, "discount");
	const text = morningDigest({
		date: "2026-10-16",
		outcomes: [{ asset: "gold", ok: true, error: null }],
		analyses: { gold: analysis },
		origin: "https://charts.example",
		token: "secret token",
	});
	assert.match(text, /STAND ASIDE/);
	assert.match(text, /Checklist: 0 pass, 2 fail, 1 not visible/);
	assert.match(text, /discount/);
	assert.match(text, /https:\/\/charts\.example\/brief\/gold\/2026-10-16\?token=secret%20token/);
	assert.equal(morningHeading("2026-10-16"), "Fri 16 Oct · 09:00 SAST");
});

test("a failed morning asset does not get a tokenised link", () => {
	const text = morningDigest({
		date: "2026-10-16",
		outcomes: [{ asset: "gold", ok: false, error: "no screenshots in KV" }],
		analyses: {},
		origin: "https://charts.example",
		token: "secret",
	});
	assert.match(text, /GOLD · no brief/);
	assert.match(text, /no screenshots in KV/);
	assert.equal(text.includes("secret"), false);
	assert.equal(isMorningPing("cron-2026-10-16"), true);
	assert.equal(isMorningPing("full-2026-10-16-1"), false);
});

test("brief html escapes model text and shows the verdict", () => {
	const html = renderBrief({
		...EXAMPLE_ANALYSIS,
		asset: "gold",
		generated_at_utc: "2026-10-16T00:00:00.000Z",
		verdict: { ...EXAMPLE_ANALYSIS.verdict, reason: "Stand aside. <script>alert(1)</script>" },
		capture: { ...EXAMPLE_ANALYSIS.capture, actual_timeframes: ["1D"] },
	}, "a&b");
	assert.match(html, /Stand aside/);
	assert.equal(html.includes("<script>"), false);
	assert.match(html, /token=a%26b/);
	assert.match(html, /\/reports\/gold\/2026-10-16\/1D\.png/);
});
