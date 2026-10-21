import type { WorkerEnv } from "../env";
import { logEvent } from "../observe";
import { getBytes, modelImageKey, putBytes, screenshotKey } from "../storage/kv";

export const MODEL_JPEG_WIDTH = 960;
export const MODEL_JPEG_QUALITY = 70;

export type ModelImage = {
	timeframe: string;
	bytes: Uint8Array;
	mime: "image/jpeg" | "image/png";
};

export async function compressModelImage(
	env: WorkerEnv,
	asset: string,
	date: string,
	timeframe: string,
	force: boolean,
): Promise<{ stored: boolean; skipped: boolean; bytes: number; error: string | null }> {
	const kv = env.CHARTS_CACHE;
	if (!kv) return { stored: false, skipped: true, bytes: 0, error: "CHARTS_CACHE namespace binding is not configured" };
	const key = modelImageKey(asset, timeframe, date);
	if (!force) {
		const existing = await getBytes(kv, key);
		if (existing) return { stored: true, skipped: true, bytes: existing.byteLength, error: null };
	}
	const png = await getBytes(kv, screenshotKey(asset, timeframe, date));
	if (!png) return { stored: false, skipped: true, bytes: 0, error: null };
	if (!env.IMAGES) {
		logEvent("compress.skipped", { asset, date, timeframe, reason: "IMAGES binding is not configured" });
		return { stored: false, skipped: true, bytes: png.byteLength, error: "IMAGES binding is not configured" };
	}
	try {
		const transformed = await env.IMAGES.input(bytesStream(png))
			.transform({ width: MODEL_JPEG_WIDTH })
			.output({ format: "image/jpeg", quality: MODEL_JPEG_QUALITY });
		const jpeg = new Uint8Array(await transformed.response().arrayBuffer());
		if (jpeg.byteLength === 0) {
			return { stored: false, skipped: true, bytes: png.byteLength, error: "empty jpeg" };
		}
		await putBytes(kv, key, jpeg, {
			asset,
			timeframe,
			date,
			source: "model-jpeg",
			width: String(MODEL_JPEG_WIDTH),
		});
		logEvent("compress.done", { asset, date, timeframe, pngBytes: png.byteLength, jpegBytes: jpeg.byteLength });
		return { stored: true, skipped: false, bytes: jpeg.byteLength, error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logEvent("compress.failed", { asset, date, timeframe, message });
		return { stored: false, skipped: true, bytes: png.byteLength, error: message };
	}
}

export async function loadModelImages(
	kv: KVNamespace,
	asset: string,
	date: string,
	timeframes: string[],
): Promise<ModelImage[]> {
	const images: ModelImage[] = [];
	for (const timeframe of timeframes) {
		const jpeg = await getBytes(kv, modelImageKey(asset, timeframe, date));
		if (jpeg) {
			images.push({ timeframe, bytes: jpeg, mime: "image/jpeg" });
			continue;
		}
		const png = await getBytes(kv, screenshotKey(asset, timeframe, date));
		if (png) images.push({ timeframe, bytes: png, mime: "image/png" });
	}
	return images;
}

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}
