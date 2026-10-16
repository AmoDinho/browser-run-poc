export function coerceAnalysis(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const row = { ...(value as Record<string, unknown>) };
	if (row.capture && typeof row.capture === "object" && !Array.isArray(row.capture)) {
		const capture = { ...(row.capture as Record<string, unknown>) };
		if (capture.capture_quality !== "ok" && capture.capture_quality !== "poor") capture.capture_quality = "poor";
		row.capture = capture;
	}
	row.confluence = coerceClaims(row.confluence);
	row.conflicts = coerceClaims(row.conflicts);
	row.invalidation = coerceConditions(row.invalidation);
	row.timeframes = coerceTimeframes(row.timeframes);
	return row;
}

function coerceClaims(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => (typeof item === "string" ? { claim: item, timeframes: [] } : item));
}

function coerceConditions(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((item) => (typeof item === "string" ? { condition: item, level: null } : item));
}

function coerceTimeframes(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((frame) => {
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) return frame;
		const row = { ...(frame as Record<string, unknown>) };
		if (Array.isArray(row.levels)) row.levels = row.levels.map(coerceLevel);
		for (const key of ["structure", "wick_extremes", "notes"] as const) {
			if (row[key] != null && typeof row[key] !== "string") row[key] = coerceLevel(row[key]);
		}
		return row;
	});
}

function coerceLevel(item: unknown): string {
	if (typeof item === "string") return item;
	if (typeof item === "number") return String(item);
	if (!item || typeof item !== "object" || Array.isArray(item)) return String(item);
	const row = item as Record<string, unknown>;
	const name = typeof row.name === "string" ? row.name : typeof row.label === "string" ? row.label : "";
	const price = row.price ?? row.value ?? row.level;
	const priceText = typeof price === "number" ? String(price) : typeof price === "string" ? price : "";
	const text = [name, priceText].filter(Boolean).join(" ");
	return text || JSON.stringify(item);
}
