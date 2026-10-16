export function screenshotKey(asset: string, timeframe: string, date: string): string {
	return `${asset}/${timeframe}/${date}.png`;
}

export function latestKey(asset: string, timeframe: string): string {
	return `${asset}/${timeframe}/latest.png`;
}

export function reportJsonKey(asset: string, date: string): string {
	return `reports/${asset}/${date}.json`;
}

export function reportMdKey(asset: string, date: string): string {
	return `reports/${asset}/${date}.md`;
}

export function runKey(asset: string, date: string): string {
	return `runs/${asset}/${date}.json`;
}

export function briefKey(asset: string, date: string): string {
	return `briefs/${asset}/${date}.html`;
}

export async function hasKey(kv: KVNamespace, key: string): Promise<boolean> {
	const value = await kv.get(key);
	return value !== null;
}

export async function getBytes(kv: KVNamespace, key: string): Promise<Uint8Array | null> {
	const value = await kv.get(key, "arrayBuffer");
	return value ? new Uint8Array(value) : null;
}

export async function putBytes(
	kv: KVNamespace,
	key: string,
	bytes: Uint8Array,
	metadata: Record<string, string>,
): Promise<void> {
	await kv.put(key, bytes, { metadata });
}

export async function getText(kv: KVNamespace, key: string): Promise<string | null> {
	return kv.get(key, "text");
}

export async function putText(kv: KVNamespace, key: string, text: string): Promise<void> {
	await kv.put(key, text);
}

export async function listReportEntries(kv: KVNamespace): Promise<{ asset: string; date: string }[]> {
	const rows: { asset: string; date: string }[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: "reports/", cursor });
		for (const key of page.keys) {
			const match = /^reports\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/.exec(key.name);
			if (!match?.[1] || !match[2]) continue;
			rows.push({ asset: match[1], date: match[2] });
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	rows.sort((a, b) => b.date.localeCompare(a.date) || a.asset.localeCompare(b.asset));
	return rows;
}
