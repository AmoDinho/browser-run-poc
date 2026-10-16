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
