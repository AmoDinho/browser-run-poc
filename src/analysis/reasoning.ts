const ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

export const REASONING_CAP = 2000;

export function capReasoningPayload(raw: string, cap = REASONING_CAP): string {
	const key = '"reasoning_content"';
	const at = raw.indexOf(key);
	if (at < 0) return raw;
	let i = at + key.length;
	while (i < raw.length && isSpace(raw[i])) i++;
	if (raw[i] !== ":") return raw;
	i++;
	while (i < raw.length && isSpace(raw[i])) i++;
	if (raw.startsWith("null", i) || raw[i] !== '"') return raw;
	const read = readJsonString(raw, i, cap);
	if (!read || !read.truncated) return raw;
	return `${raw.slice(0, i)}${JSON.stringify(read.preview)}${raw.slice(read.end)}`;
}

function readJsonString(raw: string, open: number, cap: number): { end: number; preview: string; truncated: boolean } | null {
	let i = open + 1;
	let preview = "";
	let truncated = false;
	while (i < raw.length) {
		const ch = raw[i];
		if (ch === '"') return { end: i + 1, preview, truncated };
		if (ch === "\\") {
			const next = raw[i + 1];
			if (!next) return null;
			let piece = "";
			let consumed = 2;
			if (next === "u") {
				const hex = raw.slice(i + 2, i + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
				piece = String.fromCharCode(Number.parseInt(hex, 16));
				consumed = 6;
			} else {
				piece = ESCAPES[next] ?? next;
			}
			const room = cap - preview.length;
			if (room <= 0) truncated = true;
			else if (piece.length > room) {
				preview += piece.slice(0, room);
				truncated = true;
			} else {
				preview += piece;
			}
			i += consumed;
			continue;
		}
		if (preview.length >= cap) truncated = true;
		else preview += ch;
		i++;
	}
	return null;
}

function isSpace(ch: string | undefined): boolean {
	return ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
}
