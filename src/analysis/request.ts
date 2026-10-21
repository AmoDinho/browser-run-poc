export type TextPart = { type: "text"; text: string };
export type ImagePart = {
	type: "image_url";
	image_url: { url: string; detail: "original" };
};
export type UserPart = TextPart | ImagePart;

export type ChatRequest = {
	model: string;
	messages: [
		{ role: "system"; content: string },
		{ role: "user"; content: UserPart[] },
	];
	response_format: { type: "json_object" };
	reasoning_effort: "low" | "high" | "max";
	max_tokens: 16384;
	thinking: { type: "enabled" };
};

export function buildUserContent(
	images: { label: string; base64: string; mime?: "image/png" | "image/jpeg" }[],
	runContext: string,
): UserPart[] {
	const parts: UserPart[] = [];
	images.forEach((image, index) => {
		const mime = image.mime ?? "image/png";
		parts.push({ type: "text", text: `Image ${index + 1} of ${images.length} — ${image.label}` });
		parts.push({
			type: "image_url",
			image_url: { url: `data:${mime};base64,${image.base64}`, detail: "original" },
		});
	});
	parts.push({ type: "text", text: runContext });
	return parts;
}

export function buildRunContext(input: {
	asset: string;
	date: string;
	requested: string[];
	actual: string[];
	notes: string[];
}): string {
	return [
		`Asset: ${input.asset}`,
		`UTC date: ${input.date}`,
		`Requested timeframes: ${input.requested.join(", ") || "none"}`,
		`Actual timeframes: ${input.actual.join(", ") || "none"}`,
		`Capture notes: ${input.notes.join(" ") || "none"}`,
		"Read the images above. The labels name the timeframes actually captured.",
	].join("\n");
}

export function buildChatRequest(input: {
	model: string;
	effort: "low" | "high" | "max";
	systemPrompt: string;
	userContent: UserPart[];
}): ChatRequest {
	return {
		model: input.model,
		messages: [
			{ role: "system", content: input.systemPrompt },
			{ role: "user", content: input.userContent },
		],
		response_format: { type: "json_object" },
		reasoning_effort: input.effort,
		max_tokens: 16384,
		thinking: { type: "enabled" },
	};
}
