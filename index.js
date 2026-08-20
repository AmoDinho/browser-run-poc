import puppeteer from "@cloudflare/puppeteer";

// Best-effort map of ?timeframe= values to the visible label on LiveCharts'
// own timeframe control. CONFIRM these by opening the page in a real
// browser, right-clicking the timeframe buttons, and choosing "Inspect" --
// then adjust the labels (or swap to a real CSS selector) below.
const TIMEFRAME_LABELS = {
	"1D": "1 day",
	"1W": "1 week",
	"1M": "1 month",
	"3M": "3 months",
	"1Y": "1 year",
};

export default {
	async fetch(request, env) {
		const { searchParams, pathname } = new URL(request.url);

		// Endpoint to check limits and active sessions
		if (pathname === "/status") {
			try {
				const limits = await puppeteer.limits(env.MYBROWSER);
				const sessions = await puppeteer.sessions(env.MYBROWSER);
				return new Response(JSON.stringify({ limits, sessions }, null, 2), {
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		}

		// Endpoint to manually clean up hung sessions
		if (pathname === "/cleanup") {
			try {
				const sessions = await puppeteer.sessions(env.MYBROWSER);
				const closed = [];
				for (const s of sessions) {
					try {
						const browser = await puppeteer.connect(env.MYBROWSER, s.connectionId);
						await browser.close();
						closed.push(s.connectionId);
					} catch (err) {
						// Session might already be closing/closed or not connectable
					}
				}
				return new Response(JSON.stringify({ message: `Attempted to close ${sessions.length} sessions`, closed }, null, 2), {
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		}

		const timeframe = searchParams.get("timeframe") ?? "1D";
		const label = TIMEFRAME_LABELS[timeframe] ?? TIMEFRAME_LABELS["1D"];

		let browser = null;
		try {
			// Check current execution limits
			let limits;
			try {
				limits = await puppeteer.limits(env.MYBROWSER);
			} catch (e) {
				console.error("Failed to fetch limits:", e.message);
			}

			// If remaining limit is 0, we are out of daily browser time
			if (limits && limits.remaining <= 0) {
				return new Response(
					JSON.stringify({
						error: "Daily time limit exceeded. Free tier limit is 10 minutes of active browser time per day.",
						limits,
					}),
					{ status: 429, headers: { "content-type": "application/json" } }
				);
			}

			// Auto-cleanup stale sessions if we're hitting the concurrency limit (max 3 for free tier)
			if (limits && limits.concurrent >= 3) {
				console.warn("Stale/concurrent sessions count is high. Attempting to clean up...");
				try {
					const sessions = await puppeteer.sessions(env.MYBROWSER);
					for (const s of sessions) {
						try {
							const oldBrowser = await puppeteer.connect(env.MYBROWSER, s.connectionId);
							await oldBrowser.close();
						} catch {}
					}
				} catch (err) {
					console.error("Failed auto-cleanup of sessions:", err.message);
				}
			}

			browser = await puppeteer.launch(env.MYBROWSER);
			const page = await browser.newPage();
			await page.setViewport({ width: 1280, height: 800 });

			await page.goto("https://www.livecharts.co.uk/ForexCharts/gbpusd.php", {
				waitUntil: "domcontentloaded",
				timeout: 30000,
			});

			// Best-effort: nuke any cookie banners, adblock walls, and overlays by hiding fixed/sticky elements
			try {
				await page.evaluate(() => {
					const style = document.createElement("style");
					// Add CSS to force-hide common overlays and ad blockers
					style.textContent = `
						[class*="fc-consent"], [class*="qc-cmp"], #ez-accept-all, 
						[id^="sp_message"], .adblock-wall, [style*="z-index: 2"] {
							display: none !important;
							visibility: hidden !important;
						}
					`;
					document.head.appendChild(style);

					// Also hunt down and hide any fixed/sticky elements (typically used by cookie banners)
					document.querySelectorAll('*').forEach(el => {
						const computed = window.getComputedStyle(el);
						if ((computed.position === 'fixed' || computed.position === 'sticky') && computed.zIndex > 10) {
							el.style.display = 'none';
						}
					});
					
					// Re-enable scrolling in case the ad-block wall disabled it
					document.body.style.overflow = "auto";
					document.documentElement.style.overflow = "auto";
				});
				await new Promise((resolve) => setTimeout(resolve, 2000)); // wait a bit for chart to load since we used domcontentloaded
			} catch {
				// failed to inject css/js
			}

			// Best-effort: click the timeframe control by its visible text inside the TradingView iframe
			try {
				const frame = page.frames().find(f => f.url().includes('s.tradingview.com/widgetembed') || f.url().includes('tradingview.com'));
				if (frame) {
					const dropdownSelector = '[aria-label="Chart interval"]';
					await frame.waitForSelector(dropdownSelector, { timeout: 5000 });
					await frame.click(dropdownSelector);
					await new Promise(r => setTimeout(r, 500)); // wait for dropdown to animate
					
					await frame.evaluate((text) => {
						const items = Array.from(document.querySelectorAll('div[role="row"]'));
						const targetItem = items.find(el => el.textContent && el.textContent.includes(text));
						if (targetItem) {
							targetItem.click();
						}
					}, label);
					await new Promise((resolve) => setTimeout(resolve, 2000)); // let the chart redraw
				} else {
					// Fallback for non-iframe or different chart
					await page.evaluate((text) => {
						const el = Array.from(document.querySelectorAll("button, a, span")).find(
							(n) => n.textContent && n.textContent.trim() === text,
						);
						if (el) el.click();
					}, label);
					await new Promise((resolve) => setTimeout(resolve, 1500));
				}
			} catch (err) {
				console.log("Failed to toggle timeframe:", err.message);
				// continue and just screenshot whatever is on screen
			}

			const screenshot = await page.screenshot({ type: "png" });
			return new Response(screenshot, {
				headers: { "content-type": "image/png" },
			});
		} catch (error) {
			return new Response(
				JSON.stringify({
					error: error.message,
					stack: error.stack,
					details: "An error occurred during Puppeteer browser execution. The browser has been safely closed.",
				}),
				{
					status: 500,
					headers: { "content-type": "application/json" },
				}
			);
		} finally {
			if (browser) {
				try {
					await browser.close();
				} catch (closeError) {
					console.error("Failed to close browser in finally block:", closeError.message);
				}
			}
		}
	},
};

