import context from "../../knowledge/context.md";
import methodology from "../../knowledge/methodology.md";
import { exampleJson } from "./schema";
import { markdownH2 } from "./sections";

export const PROMPT_VERSION = "2";
export const METHODOLOGY_SECTIONS = markdownH2(methodology);
export const CONTEXT_SECTIONS = markdownH2(context);
export const CITABLE_SECTIONS = [...METHODOLOGY_SECTIONS, ...CONTEXT_SECTIONS];

export function assembleSystemPrompt(methodologyText: string, contextText: string, example: string): string {
	const methodSections = markdownH2(methodologyText);
	const contextSections = markdownH2(contextText);
	return [
		methodologyText.trim(),
		"",
		"Reference context is stored separately and follows. Use it for definitions of trend, level, candle signals, confluence, and risk arithmetic. It does not override the decision procedure above. If they conflict, the decision procedure wins.",
		"",
		contextText.trim(),
		"",
		"Output rules:",
		"- Apply the decision procedure. Cite a section heading from the decision procedure or the reference context for each judgement in method_citations. If neither document covers something, say so. Do not invent a method.",
		`- Decision-procedure headings: ${methodSections.join("; ")}.`,
		`- Reference-context headings: ${contextSections.join("; ")}.`,
		"- The user message images are the only charts. Missing roles are NOT VISIBLE.",
		"- Any mandatory checklist FAIL or NOT VISIBLE means verdict.direction stand_aside and verdict.grade NO TRADE.",
		"- verdict.direction is long, short, or stand_aside. bias.direction is bullish, bearish, neutral, or unclear.",
		"- Levels you cannot read are null, not guesses. Estimated levels must contain (est.).",
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

export const SYSTEM_PROMPT = assembleSystemPrompt(methodology, context, exampleJson());
