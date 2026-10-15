import { CLIP_MAX_HEIGHT, CLIP_MAX_WIDTH, MIN_CHART_HEIGHT, MIN_CHART_WIDTH } from "./config";

export type Box = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export function isChartBoxVisible(box: { width: number; height: number } | null): boolean {
	if (!box) return false;
	return box.width >= MIN_CHART_WIDTH && box.height >= MIN_CHART_HEIGHT;
}

export function clipBox(box: Box): Box {
	return {
		x: Math.max(0, Math.round(box.x)),
		y: Math.max(0, Math.round(box.y)),
		width: Math.round(Math.min(box.width, CLIP_MAX_WIDTH)),
		height: Math.round(Math.min(box.height, CLIP_MAX_HEIGHT)),
	};
}

export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24) return null;
	const sig = [137, 80, 78, 71, 13, 10, 26, 10];
	for (let i = 0; i < sig.length; i++) {
		if (bytes[i] !== sig[i]) return null;
	}
	const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
	if (type !== "IHDR") return null;
	return { width: readU32(bytes, 16), height: readU32(bytes, 20) };
}

export function pngFailsVisibility(bytes: Uint8Array): boolean {
	return !isChartBoxVisible(pngSize(bytes));
}

export function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function readU32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] ?? 0) << 24) |
		((bytes[offset + 1] ?? 0) << 16) |
		((bytes[offset + 2] ?? 0) << 8) |
		(bytes[offset + 3] ?? 0)
	) >>> 0;
}
