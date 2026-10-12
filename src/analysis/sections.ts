export function markdownH2(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter((line) => line.startsWith("## "))
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
}
