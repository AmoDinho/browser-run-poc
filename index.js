import puppeteer from "@cloudflare/puppeteer";

// Best-effort map of ?timeframe= values to the visible label on LiveCharts'
// own timeframe control. CONFIRM these by opening the page in a real
// browser, right-clicking the timeframe buttons, and choosing "Inspect" --
// then adjust the labels (or swap to a real CSS selector) below.
const TIMEFRAME_LABELS = {
	"1D": "1D",
	"1W": "1W",
	"1M": "1M",
	"3M": "3M",
	"1Y": "1Y",
};

export default {
	async fetch(request, env) {
		const { searchParams } = new URL(request.url);
		const timeframe = searchParams.get("timeframe") ?? "1D";
		const label = TIMEFRAME_LABELS[timeframe] ?? TIMEFRAME_LABELS["1D"];

		const browser = await puppeteer.launch(env.MYBROWSER);
		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });

		await page.goto("https://www.livecharts.co.uk/ForexCharts/gbpusd.php", {
			waitUntil: "networkidle0",
		});

		// Best-effort: dismiss a cookie/consent banner if one shows up.
		try {
			const consentButton = await page.$(
				"button[aria-label='Accept'], button[aria-label='Agree'], #onetrust-accept-btn-handler",
			);
			if (consentButton) await consentButton.click();
		} catch {
			// no consent banner found -- fine, keep going
		}

		// Best-effort: click the timeframe control by its visible text.
		// TODO: replace with the real selector once you've confirmed it in devtools.
		try {
			await page.evaluate((text) => {
				const el = Array.from(document.querySelectorAll("button, a, span")).find(
					(n) => n.textContent && n.textContent.trim() === text,
				);
				if (el) el.click();
			}, label);
			await new Promise((resolve) => setTimeout(resolve, 1500)); // let the chart redraw
		} catch {
			// continue and just screenshot whatever is on screen
		}

		const screenshot = await page.screenshot({ type: "png" });
		await browser.close();

		return new Response(screenshot, {
			headers: { "content-type": "image/png" },
		});
	},
};
