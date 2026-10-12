import methodology from "../../knowledge/methodology.md";
import { exampleJson } from "./schema";
import { markdownH2 } from "./sections";

export const PROMPT_VERSION = "1";
export const METHODOLOGY_SECTIONS = markdownH2(methodology);

export function assembleSystemPrompt(methodologyText: string, example: string): string {
	const sections = markdownH2(methodologyText);
	return [
		methodologyText.trim(),
		"",
		"Output rules:",
		"- Apply the methodology above. Cite the section heading for each judgement in method_citations. If the methodology does not cover something, say so. Do not invent a method.",
		`- Cite only these section headings: ${sections.join("; ")}.`,
		"- Read top-down: longest timeframe for context, shortest for timing. State where the timeframes disagree.",
		"- Describe only what is visible. No invented indicator values. Levels read off an axis are approximate.",
		"- If an image is blank, obscured, or the wrong timeframe, set capture_quality to poor and explain. That is a successful analysis of a bad capture, not a failed run.",
		"- No buy or sell recommendations. Structure, levels, and invalidation only. direction is up, down, mixed, or unclear.",
		"- confidence is low, medium, or high.",
		"- Use null for unknown nullable fields. Do not omit fields.",
		"- The example is a shape fixture. Replace every value from the images. Do not copy example strings.",
		"- Output one json object matching the example. No markdown fence.",
		"",
		"Example json object:",
		example,
		"",
	].join("\n");
}

export const SYSTEM_PROMPT = assembleSystemPrompt(methodology, exampleJson());
