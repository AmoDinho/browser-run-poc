export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function markdownToHtml(markdown: string, imagePrefix: string, token: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let list: string[] | null = null;
	const flushList = () => {
		if (!list) return;
		out.push(`<ul>${list.join("")}</ul>`);
		list = null;
	};
	for (const line of lines) {
		const image = /^!\[([^\]]*)\]\(\.\/([A-Za-z0-9]+)\.png\)$/.exec(line);
		if (image) {
			flushList();
			const alt = escapeHtml(image[1] ?? "");
			const file = image[2] ?? "";
			const src = `${imagePrefix}/${file}.png?token=${encodeURIComponent(token)}`;
			out.push(`<p><img alt="${alt}" src="${escapeHtml(src)}"></p>`);
			continue;
		}
		if (line.startsWith("### ")) {
			flushList();
			out.push(`<h3>${inline(line.slice(4))}</h3>`);
			continue;
		}
		if (line.startsWith("## ")) {
			flushList();
			out.push(`<h2>${inline(line.slice(3))}</h2>`);
			continue;
		}
		if (line.startsWith("# ")) {
			flushList();
			out.push(`<h1>${inline(line.slice(2))}</h1>`);
			continue;
		}
		if (line.startsWith("> ")) {
			flushList();
			out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
			continue;
		}
		if (line === "---") {
			flushList();
			out.push("<hr>");
			continue;
		}
		if (line.startsWith("- ")) {
			list ??= [];
			list.push(`<li>${inline(line.slice(2))}</li>`);
			continue;
		}
		if (line.trim() === "") {
			flushList();
			continue;
		}
		flushList();
		out.push(`<p>${inline(line)}</p>`);
	}
	flushList();
	return out.join("\n");
}

export function reportPage(input: { title: string; markdown: string; imagePrefix: string; token: string }): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
img{max-width:100%;height:auto}
blockquote{border-left:4px solid #b45309;background:#fff7ed;margin:1rem 0;padding:.75rem 1rem}
hr{border:0;border-top:1px solid #ddd;margin:2rem 0}
</style>
</head>
<body>
<article>
${markdownToHtml(input.markdown, input.imagePrefix, input.token)}
</article>
</body>
</html>`;
}

export function reportsListPage(rows: { asset: string; date: string }[], token: string): string {
	const items =
		rows.length === 0
			? "<p>No reports.</p>"
			: `<ul>${rows
					.map((row) => {
						const href = `/reports/${encodeURIComponent(row.asset)}/${row.date}?token=${encodeURIComponent(token)}`;
						return `<li><a href="${escapeHtml(href)}">${escapeHtml(row.date)} ${escapeHtml(row.asset)}</a></li>`;
					})
					.join("")}</ul>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Reports</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
<h1>Reports</h1>
${items}
</body>
</html>`;
}

function inline(text: string): string {
	return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
