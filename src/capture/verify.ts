import { INTERVAL_BUTTON_TOKENS, TIMEFRAME_FALLBACK, TIMEFRAME_LABELS, isTimeframe } from "./config";

export function intervalLabelMatches(readback: string, timeframe: string, fullLabel: string): boolean {
	const raw = readback.toLowerCase();
	if (!raw.trim()) return false;
	if (raw.includes(fullLabel.toLowerCase())) return true;
	if (!isTimeframe(timeframe)) return false;
	const tokens = INTERVAL_BUTTON_TOKENS[timeframe].map((token) => token.toLowerCase());
	return raw
		.split("|")
		.map((part) => part.trim())
		.filter(Boolean)
		.some((part) => tokens.includes(part));
}

export function isDuplicateHash(hash: string, seen: readonly string[]): boolean {
	return seen.includes(hash);
}

export function resolveTimeframeChoice(
	requested: string,
	menuLabels: readonly string[],
	alreadyCaptured: readonly string[],
): { timeframe: string; label: string; note: string | null } | null {
	if (!isTimeframe(requested)) return null;
	const label = TIMEFRAME_LABELS[requested];
	if (menuHas(menuLabels, label)) return { timeframe: requested, label, note: null };
	const fallback = TIMEFRAME_FALLBACK[requested];
	if (!fallback || alreadyCaptured.includes(fallback)) return null;
	const fallbackLabel = TIMEFRAME_LABELS[fallback];
	if (!menuHas(menuLabels, fallbackLabel)) return null;
	return {
		timeframe: fallback,
		label: fallbackLabel,
		note: `${requested} label "${label}" was absent; used ${fallback} ("${fallbackLabel}")`,
	};
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const tight = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer;
	const data = tight ? bytes.buffer : bytes.slice().buffer;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	let hex = "";
	for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function menuHas(menuLabels: readonly string[], label: string): boolean {
	const needle = label.toLowerCase();
	return menuLabels.some((item) => item.toLowerCase().includes(needle));
}
