import type { ChartAnalysis } from "../analysis/schema";
import type { WorkerEnv } from "../env";
import { briefKey, getText, putText, reportJsonKey } from "../storage/kv";
import { chartAnalysisSchema } from "../analysis/schema";
import { escapeHtml } from "./html";
import { extractRange, formatPrice, rangePercent } from "./range";

const ASSET_LABELS: Record<string, string> = {
	gold: "Gold",
	nasdaq100: "Nasdaq 100",
};

export function renderBrief(analysis: ChartAnalysis, token: string): string {
	const asset = ASSET_LABELS[analysis.asset] ?? analysis.asset;
	const date = briefDate(analysis.generated_at_utc.slice(0, 10) || "1970-01-01");
	const verdict = verdictLabel(analysis.verdict.direction);
	const range = extractRange(analysis);
	const charts = analysis.capture.actual_timeframes
		.map((timeframe) => {
			const frame = analysis.timeframes.find((item) => item.timeframe === timeframe);
			const src = `/reports/${encodeURIComponent(analysis.asset)}/${analysis.generated_at_utc.slice(0, 10)}/${encodeURIComponent(timeframe)}.png?token=${encodeURIComponent(token)}`;
			return `<figure>
<figcaption>${escapeHtml(timeframe)}</figcaption>
<img alt="${escapeHtml(`${asset} ${timeframe}`)}" src="${escapeHtml(src)}">
${frame?.structure ? `<p>${escapeHtml(frame.structure)}</p>` : ""}
</figure>`;
		})
		.join("\n");
	const checks = analysis.verdict.checklist
		.map(
			(item) => `<li><span>${escapeHtml(item.item)}</span><span class="result ${resultClass(item.result)}">${escapeHtml(item.result)}</span></li>`,
		)
		.join("");
	const conflicts = analysis.conflicts.map((item) => `<li>${escapeHtml(item.claim)}</li>`).join("");
	const invalidation = analysis.invalidation
		.map((item) => `<li>${escapeHtml([item.condition, item.level].filter(Boolean).join(" "))}</li>`)
		.join("");
	const caveats = analysis.caveats.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(`${asset} · ${verdict}`)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f1ea;--ink:#1c1916;--muted:#6f675e;--line:#e3dbd0;--zone:#ddd4c6;--fail:#9a3412;--pass:#3f6212;--miss:#78716c;--mark:#9a3412}
@media (prefers-color-scheme:dark){:root{--bg:#12110f;--ink:#f4efe7;--muted:#a79d92;--line:#2b2723;--zone:#3a342c;--fail:#fdba74;--pass:#d9f99d;--miss:#a8a29e;--mark:#fdba74}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 ui-sans-serif,system-ui,sans-serif;padding:max(1.25rem,env(safe-area-inset-top)) 1rem max(2.5rem,env(safe-area-inset-bottom))}
main{max-width:40rem;margin:0 auto}
.kicker,.grade,h2{color:var(--muted)}
.kicker,h2{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
h1{font-size:2.05rem;line-height:1.05;font-weight:560;letter-spacing:-.03em;margin:.35rem 0 .4rem}
.grade{margin:0}
.reason{font-size:1.05rem;margin:1rem 0 0}
h2{margin:1.75rem 0 .7rem}
.rail{position:relative;height:8px;margin:1.6rem .4rem .45rem;border-radius:999px;background:var(--line)}
.zone{position:absolute;left:0;top:0;bottom:0;border-radius:999px 0 0 999px;background:var(--zone)}
.eq{position:absolute;top:-7px;width:2px;height:22px;background:var(--ink);transform:translateX(-50%)}
.close{position:absolute;top:50%;width:14px;height:14px;border-radius:50%;background:var(--mark);transform:translate(-50%,-50%)}
.scale{display:flex;justify-content:space-between;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
.side{margin:.45rem 0 0}
ul{list-style:none;padding:0;margin:0}
.checks li{display:flex;gap:.75rem;justify-content:space-between;align-items:baseline;padding:.7rem 0;border-top:1px solid var(--line)}
.result{flex:0 0 auto;font-size:.75rem;letter-spacing:.04em}
.fail{color:var(--fail)}.pass{color:var(--pass)}.miss{color:var(--miss)}
figure{margin:0 0 1.35rem}
figcaption{font-size:.8rem;color:var(--muted);margin:0 0 .4rem}
img{width:100%;height:auto;border-radius:10px;background:var(--line)}
.notes li{padding:.35rem 0;color:var(--muted)}
</style>
</head>
<body>
<main>
<p class="kicker">${escapeHtml(asset)} · ${escapeHtml(date)}</p>
<h1>${escapeHtml(verdict)}</h1>
<p class="grade">${escapeHtml(analysis.verdict.grade)} · ${escapeHtml(analysis.confidence)} confidence</p>
${analysis.verdict.reason ? `<p class="reason">${escapeHtml(analysis.verdict.reason)}</p>` : ""}
${range ? rangeBlock(range) : ""}
<h2>Checklist</h2>
<ul class="checks">${checks || `<li><span>No checklist</span><span class="result miss">NOT VISIBLE</span></li>`}</ul>
<h2>Charts</h2>
${charts || `<p class="reason">No charts stored.</p>`}
${conflicts ? `<h2>Conflicts</h2><ul class="notes">${conflicts}</ul>` : ""}
${invalidation ? `<h2>Invalidation</h2><ul class="notes">${invalidation}</ul>` : ""}
${caveats ? `<h2>Caveats</h2><ul class="notes">${caveats}</ul>` : ""}
</main>
</body>
</html>`;
}

export async function writeBrief(env: WorkerEnv, asset: string, date: string): Promise<void> {
	const kv = env.CHARTS_CACHE;
	if (!kv) throw new Error("CHARTS_CACHE namespace binding is not configured");
	const raw = await getText(kv, reportJsonKey(asset, date));
	if (!raw) throw new Error("no report to brief");
	const analysis = chartAnalysisSchema.parse(JSON.parse(raw));
	await putText(kv, briefKey(asset, date), renderBrief({ ...analysis, asset, generated_at_utc: `${date}T00:00:00.000Z` }, env.VIEWER_TOKEN ?? ""));
}

function rangeBlock(range: NonNullable<ReturnType<typeof extractRange>>): string {
	const eq = rangePercent(range.equilibrium, range.low, range.high).toFixed(2);
	const close = rangePercent(range.close, range.low, range.high).toFixed(2);
	const label = `Close ${formatPrice(range.close)} is in ${range.side}, equilibrium ${formatPrice(range.equilibrium)}`;
	return `<h2>Range</h2>
<div class="rail" role="img" aria-label="${escapeHtml(label)}">
<div class="zone" style="width:${eq}%"></div>
<div class="eq" style="left:${eq}%"></div>
<div class="close" style="left:${close}%"></div>
</div>
<div class="scale"><span>${escapeHtml(formatPrice(range.low))}</span><span>${escapeHtml(formatPrice(range.equilibrium))}</span><span>${escapeHtml(formatPrice(range.high))}</span></div>
<p class="side">${escapeHtml(label)}</p>`;
}

function verdictLabel(direction: ChartAnalysis["verdict"]["direction"]): string {
	if (direction === "stand_aside") return "Stand aside";
	if (direction === "long") return "Long";
	return "Short";
}

function resultClass(result: string): string {
	if (result === "FAIL") return "fail";
	if (result === "PASS") return "pass";
	return "miss";
}

function briefDate(date: string): string {
	const when = new Date(`${date}T12:00:00.000Z`);
	if (Number.isNaN(when.getTime())) return date;
	const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: "UTC" }).format(when);
	const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(when);
	const year = new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone: "UTC" }).format(when);
	return `${day} ${month} ${year}`;
}
