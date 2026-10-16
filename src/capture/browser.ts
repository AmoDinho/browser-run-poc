import puppeteer, { type Browser, type Frame, type Page } from "@cloudflare/puppeteer";
import type { WorkerEnv } from "../env";
import { latestKey, putBytes, screenshotKey, hasKey } from "../storage/kv";
import {
	ASSET_URLS,
	DAILY_TIMEFRAMES,
	TIMEFRAME_LABELS,
	isAsset,
	isTimeframe,
	type Timeframe,
} from "./config";
import { clipBox, isChartBoxVisible, pngFailsVisibility, pngSize, type Box } from "./visibility";
import { intervalLabelMatches, isDuplicateHash, resolveTimeframeChoice, sha256Hex } from "./verify";

const INTERVAL_ROOT = "#header-toolbar-intervals";
const INTERVAL_SELECTOR = `${INTERVAL_ROOT} [aria-label="Chart interval"]`;

export class QuotaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QuotaError";
	}
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export type CapturedFrame = {
	timeframe: string;
	label: string;
	key: string | null;
	hash: string | null;
	width: number | null;
	height: number | null;
	intervalVerified: boolean;
	stored: boolean;
	note: string | null;
};

export type CaptureAssetResult = {
	asset: string;
	date: string;
	requestedTimeframes: string[];
	actualTimeframes: string[];
	frames: CapturedFrame[];
	notes: string[];
	skipped: boolean;
	captureQuality: "ok" | "poor";
	bytes?: Uint8Array;
};

export type CaptureStepResult = Omit<CaptureAssetResult, "bytes">;

export type CaptureRequest = {
	asset: string;
	date: string;
	timeframes: string[];
	force: boolean;
	store: boolean;
};

export function toStepResult(result: CaptureAssetResult): CaptureStepResult {
	const { bytes: _bytes, ...rest } = result;
	return rest;
}

export async function checkLimits(env: WorkerEnv): Promise<{ allowed: true } | { allowed: false; response: Response }> {
	try {
		const limits = await puppeteer.limits(env.MYBROWSER);
		if (quotaBlocked(limits)) {
			return {
				allowed: false,
				response: new Response(
					JSON.stringify({
						error: "Daily time limit exceeded. Free tier limit is 10 minutes of active browser time per day.",
						limits,
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				),
			};
		}
		if (concurrencyHigh(limits)) {
			console.warn("Stale/concurrent sessions count is high. Attempting to clean up...");
			await cleanupSessions(env);
		}
		return { allowed: true };
	} catch (error) {
		console.error(`Failed to check limits/sessions: ${error instanceof Error ? error.message : String(error)}`);
		return { allowed: true };
	}
}

export async function readStatus(env: WorkerEnv): Promise<{ limits: unknown; sessions: unknown }> {
	const limits = await puppeteer.limits(env.MYBROWSER);
	const sessions = await puppeteer.sessions(env.MYBROWSER);
	return { limits, sessions };
}

export async function cleanupSessions(env: WorkerEnv): Promise<{ closed: string[]; count: number }> {
	const sessions = await puppeteer.sessions(env.MYBROWSER);
	const closed: string[] = [];
	for (const session of sessions) {
		const id = session.connectionId ?? session.sessionId;
		if (!id) continue;
		try {
			const browser = await puppeteer.connect(env.MYBROWSER, id);
			await browser.close();
			closed.push(id);
		} catch {
			// session already closing
		}
	}
	return { closed, count: sessions.length };
}

export async function captureScreenshot(asset: string, timeframe: string, env: WorkerEnv): Promise<Uint8Array> {
	const result = await captureAsset(env, {
		asset,
		date: new Date().toISOString().slice(0, 10),
		timeframes: [timeframe],
		force: true,
		store: false,
	});
	if (!result.bytes) throw new Error(result.notes.join("; ") || "Capture failed visibility or interval verification");
	return result.bytes;
}

export async function captureAsset(env: WorkerEnv, request: CaptureRequest): Promise<CaptureAssetResult> {
	if (!isAsset(request.asset)) throw new ConfigError(`Invalid asset ${request.asset}`);
	const timeframes = request.timeframes.filter(isTimeframe);
	if (timeframes.length === 0) throw new ConfigError("No timeframes to capture");
	const limit = await checkLimits(env);
	if (!limit.allowed) throw new QuotaError("Daily time limit exceeded");
	if (request.store && !env.CHARTS_CACHE) throw new ConfigError("CHARTS_CACHE namespace binding is not configured");
	if (request.store && env.CHARTS_CACHE && !request.force) {
		const present: string[] = [];
		for (const timeframe of timeframes) {
			if (await hasKey(env.CHARTS_CACHE, screenshotKey(request.asset, timeframe, request.date))) present.push(timeframe);
		}
		if (present.length === timeframes.length) {
			return {
				asset: request.asset,
				date: request.date,
				requestedTimeframes: timeframes,
				actualTimeframes: present,
				frames: present.map((timeframe) => ({
					timeframe,
					label: TIMEFRAME_LABELS[timeframe as Timeframe],
					key: screenshotKey(request.asset, timeframe, request.date),
					hash: null,
					width: null,
					height: null,
					intervalVerified: true,
					stored: true,
					note: null,
				})),
				notes: ["capture skipped; dated screenshots already present"],
				skipped: true,
				captureQuality: "ok",
			};
		}
	}
	const browser = await puppeteer.launch(env.MYBROWSER);
	try {
		return await captureInBrowser(browser, env, request, timeframes);
	} finally {
		try {
			await browser.close();
		} catch (error) {
			console.error(`Failed to close browser: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function captureInBrowser(
	browser: Browser,
	env: WorkerEnv,
	request: CaptureRequest,
	timeframes: Timeframe[],
): Promise<CaptureAssetResult> {
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 900 });
	await page.goto(ASSET_URLS[request.asset as keyof typeof ASSET_URLS], { waitUntil: "domcontentloaded", timeout: 30000 });
	await dismissConsent(page);
	const notes: string[] = [];
	const frames: CapturedFrame[] = [];
	const seen: string[] = [];
	let loneBytes: Uint8Array | undefined;
	for (const timeframe of timeframes) {
		try {
			const captured = await captureOne(page, timeframe, seen, frames.filter((item) => item.stored).map((item) => item.timeframe));
			if (!captured.stored || !captured.bytes || !captured.hash) {
				frames.push(stripBytes(captured.frame));
				notes.push(captured.note ?? `${timeframe}: not stored`);
				continue;
			}
			if (captured.note) notes.push(captured.note);
			if (isDuplicateHash(captured.hash, seen)) {
				frames.push({ ...stripBytes(captured.frame), stored: false, note: "duplicate hash" });
				notes.push(`${timeframe}: interval verification failed; screenshot matched a previous timeframe`);
				continue;
			}
			seen.push(captured.hash);
			if (request.store && env.CHARTS_CACHE) {
				const key = screenshotKey(request.asset, captured.frame.timeframe, request.date);
				const metadata = {
					asset: request.asset,
					timeframe: captured.frame.timeframe,
					date: request.date,
					hash: captured.hash,
					width: String(captured.frame.width ?? ""),
					height: String(captured.frame.height ?? ""),
				};
				await putBytes(env.CHARTS_CACHE, key, captured.bytes, metadata);
				await putBytes(env.CHARTS_CACHE, latestKey(request.asset, captured.frame.timeframe), captured.bytes, metadata);
				frames.push({ ...stripBytes(captured.frame), key, stored: true });
			} else {
				loneBytes = captured.bytes;
				frames.push({ ...stripBytes(captured.frame), stored: true });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notes.push(`${timeframe}: ${message}`);
			frames.push({
				timeframe,
				label: TIMEFRAME_LABELS[timeframe],
				key: null,
				hash: null,
				width: null,
				height: null,
				intervalVerified: false,
				stored: false,
				note: message,
			});
		}
	}
	const actual = frames.filter((frame) => frame.stored).map((frame) => frame.timeframe);
	const verified = frames.filter((frame) => frame.stored).every((frame) => frame.intervalVerified);
	return {
		asset: request.asset,
		date: request.date,
		requestedTimeframes: timeframes,
		actualTimeframes: actual,
		frames,
		notes,
		skipped: false,
		captureQuality: actual.length === timeframes.length && verified ? "ok" : "poor",
		...(loneBytes ? { bytes: loneBytes } : {}),
	};
}

type OneCapture = {
	frame: CapturedFrame;
	bytes: Uint8Array | null;
	hash: string | null;
	stored: boolean;
	note: string | null;
};

async function captureOne(page: Page, requested: Timeframe, seen: string[], alreadyCaptured: string[]): Promise<OneCapture> {
	const frame = tradingViewFrame(page);
	if (!frame) return failed(requested, "tradingview frame not found");
	let choice: { timeframe: string; label: string; note: string | null };
	try {
		await frame.waitForSelector(INTERVAL_ROOT, { timeout: 8000 });
		const current = await readInterval(frame);
		if (intervalLabelMatches(current, requested, TIMEFRAME_LABELS[requested])) {
			choice = { timeframe: requested, label: TIMEFRAME_LABELS[requested], note: null };
			await sleep(1500);
		} else if (await clickToolbarRadio(frame, TIMEFRAME_LABELS[requested])) {
			choice = { timeframe: requested, label: TIMEFRAME_LABELS[requested], note: null };
			await sleep(3000);
		} else {
			await frame.click(INTERVAL_SELECTOR);
			await sleep(800);
			const menu = await menuLabels(frame);
			const picked = resolveTimeframeChoice(requested, menu, alreadyCaptured);
			if (!picked) return failed(requested, `interval label absent; menu=${menu.join(" | ") || "empty"}; button=${current}`);
			choice = picked;
			const clicked = await clickLabel(frame, choice.label);
			if (!clicked) return failed(requested, `failed to click ${choice.label}`);
			await sleep(3000);
		}
	} catch (error) {
		return failed(requested, error instanceof Error ? error.message : String(error));
	}
	let lastNote = choice.note;
	for (let attempt = 0; attempt < 2; attempt++) {
		const readback = await readInterval(frame);
		const labelOk = intervalLabelMatches(readback, choice.timeframe, choice.label);
		const box = await chartBox(page);
		if (!isChartBoxVisible(box) || !box) {
			lastNote = `${choice.timeframe}: chart box ${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "missing"}`;
			if (attempt === 0) {
				await reselect(frame, choice.label);
				continue;
			}
			return failed(choice.timeframe as Timeframe, lastNote);
		}
		const bytes = await screenshot(page, box);
		const size = pngSize(bytes);
		if (!size || pngFailsVisibility(bytes)) {
			lastNote = `${choice.timeframe}: png ${size ? `${size.width}x${size.height}` : "invalid"}`;
			if (attempt === 0) {
				await reselect(frame, choice.label);
				continue;
			}
			return failed(choice.timeframe as Timeframe, lastNote);
		}
		const hash = await sha256Hex(bytes);
		if (!labelOk || isDuplicateHash(hash, seen)) {
			lastNote = `${choice.timeframe}: interval unverified button=${readback || "empty"} duplicate=${isDuplicateHash(hash, seen)}`;
			if (attempt === 0) {
				await reselect(frame, choice.label);
				continue;
			}
			return failed(choice.timeframe as Timeframe, lastNote);
		}
		const note = [choice.note, lastNote].filter(Boolean).join("; ") || null;
		return {
			stored: true,
			bytes,
			hash,
			note,
			frame: {
				timeframe: choice.timeframe,
				label: choice.label,
				key: null,
				hash,
				width: size.width,
				height: size.height,
				intervalVerified: true,
				stored: true,
				note,
			},
		};
	}
	return failed(requested, lastNote ?? `${requested}: capture failed`);
}

async function reselect(frame: Frame, label: string): Promise<void> {
	try {
		if (await clickToolbarRadio(frame, label)) {
			await sleep(3000);
			return;
		}
		await frame.click(INTERVAL_SELECTOR);
		await sleep(800);
		await clickLabel(frame, label);
		await sleep(3000);
	} catch (error) {
		console.warn(`Failed to toggle timeframe: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function failed(timeframe: Timeframe, note: string): OneCapture {
	return {
		stored: false,
		bytes: null,
		hash: null,
		note,
		frame: {
			timeframe,
			label: TIMEFRAME_LABELS[timeframe],
			key: null,
			hash: null,
			width: null,
			height: null,
			intervalVerified: false,
			stored: false,
			note,
		},
	};
}

function stripBytes(frame: CapturedFrame): CapturedFrame {
	return frame;
}

async function screenshot(page: Page, box: Box): Promise<Uint8Array> {
	const raw = await page.screenshot({ type: "png", clip: clipBox(box) });
	return new Uint8Array(raw);
}

async function chartBox(page: Page): Promise<Box | null> {
	const frame = tradingViewFrame(page);
	if (!frame) return null;
	const element = await frame.frameElement();
	if (!element) return null;
	await element.evaluate((el) => {
		el.scrollIntoView({ block: "center", inline: "nearest" });
	});
	return element.boundingBox();
}

function tradingViewFrame(page: Page): Frame | null {
	return (
		page.frames().find((frame) => {
			const url = frame.url();
			return url.includes("s.tradingview.com/widgetembed") || url.includes("tradingview.com");
		}) ?? null
	);
}

async function readInterval(frame: Frame): Promise<string> {
	return frame.evaluate(() => {
		const root = document.querySelector("#header-toolbar-intervals");
		const checked = root?.querySelector('button[role="radio"][aria-checked="true"]');
		const legend = document.querySelector('[data-qa-id~="legend-source-interval"]');
		return [
			checked?.getAttribute("aria-label") ?? "",
			checked?.getAttribute("data-value") ?? "",
			checked?.textContent ?? "",
			legend?.textContent ?? "",
		]
			.join(" | ")
			.replace(/\s+/g, " ")
			.trim();
	});
}

async function clickToolbarRadio(frame: Frame, label: string): Promise<boolean> {
	return frame.evaluate((text) => {
		const root = document.querySelector("#header-toolbar-intervals");
		if (!root) return false;
		const radio = Array.from(root.querySelectorAll('button[role="radio"]')).find((el) => {
			const name = (el.getAttribute("aria-label") ?? el.getAttribute("data-tooltip") ?? "").toLowerCase();
			return name === text.toLowerCase();
		});
		if (!(radio instanceof HTMLElement)) return false;
		if (radio.getAttribute("aria-checked") !== "true") radio.click();
		return true;
	}, label);
}

async function menuLabels(frame: Frame): Promise<string[]> {
	return frame.evaluate(() => {
		const items = document.querySelectorAll('[data-qa-id="interval-menu-item"]');
		const nodes = items.length > 0 ? items : document.querySelectorAll('div[role="row"]');
		return Array.from(nodes)
			.map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
			.filter(Boolean);
	});
}

async function clickLabel(frame: Frame, label: string): Promise<boolean> {
	return frame.evaluate((text) => {
		const items = document.querySelectorAll('[data-qa-id="interval-menu-item"]');
		const nodes = items.length > 0 ? items : document.querySelectorAll('div[role="row"]');
		const target = Array.from(nodes).find((el) => el.textContent?.toLowerCase().includes(text.toLowerCase()));
		if (!target) return false;
		if (target instanceof HTMLElement) target.click();
		else target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		return true;
	}, label);
}

async function dismissConsent(page: Page): Promise<void> {
	try {
		await page.evaluate(() => {
			const style = document.createElement("style");
			style.textContent = `
				[class*="fc-consent"], [class*="qc-cmp"], #ez-accept-all,
				[id^="sp_message"], .adblock-wall, [style*="z-index: 2"] {
					display: none !important;
					visibility: hidden !important;
				}
			`;
			document.head.appendChild(style);
			document.querySelectorAll("*").forEach((el) => {
				const computed = window.getComputedStyle(el);
				if ((computed.position === "fixed" || computed.position === "sticky") && Number(computed.zIndex) > 10) {
					if (el instanceof HTMLElement) el.style.display = "none";
				}
			});
			document.body.style.overflow = "auto";
			document.documentElement.style.overflow = "auto";
		});
		await sleep(3000);
	} catch {
		// stylesheet injection failure
	}
}

function quotaBlocked(limits: unknown): boolean {
	if (!limits || typeof limits !== "object") return false;
	const row = limits as Record<string, unknown>;
	if (typeof row.remaining === "number" && row.remaining <= 0) return true;
	if (typeof row.allowedBrowserAcquisitions === "number" && row.allowedBrowserAcquisitions <= 0) return true;
	return false;
}

function concurrencyHigh(limits: unknown): boolean {
	if (!limits || typeof limits !== "object") return false;
	const row = limits as Record<string, unknown>;
	if (typeof row.concurrent === "number" && row.concurrent >= 3) return true;
	const active = Array.isArray(row.activeSessions) ? row.activeSessions.length : 0;
	const max = typeof row.maxConcurrentSessions === "number" ? row.maxConcurrentSessions : 3;
	return active >= max && active > 0;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_TIMEFRAMES = DAILY_TIMEFRAMES;
