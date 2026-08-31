import puppeteer from "@cloudflare/puppeteer";

const ASSET_URLS = {
	"nasdaq100": "https://www.livecharts.co.uk/MarketCharts/nasdaq100.php",
	"gold": "https://www.livecharts.co.uk/MarketCharts/gold.php",
};

const TIMEFRAME_LABELS = {
	"30m": "30 minutes",
	"3h": "3 hours",
	"1D": "1 day",
	"1W": "1 week",
	"1M": "1 month",
	"3M": "3 months",
	"1Y": "12 months",
};

// Helper to check execution limits and manage concurrency
async function checkLimits(env) {
	try {
		const limits = await puppeteer.limits(env.MYBROWSER);
		if (limits && limits.remaining <= 0) {
			return {
				allowed: false,
				response: new Response(
					JSON.stringify({
						error: "Daily time limit exceeded. Free tier limit is 10 minutes of active browser time per day.",
						limits,
					}),
					{ status: 429, headers: { "content-type": "application/json" } }
				)
			};
		}
		// Auto-cleanup stale sessions if hitting concurrency limit (max 3 for free tier)
		if (limits && limits.concurrent >= 3) {
			console.warn("Stale/concurrent sessions count is high. Attempting to clean up...");
			const sessions = await puppeteer.sessions(env.MYBROWSER);
			for (const s of sessions) {
				try {
					const oldBrowser = await puppeteer.connect(env.MYBROWSER, s.connectionId);
					await oldBrowser.close();
				} catch {}
			}
		}
		return { allowed: true };
	} catch (e) {
		console.error("Failed to check limits/sessions:", e.message);
		return { allowed: true }; // Fallback to allowing execution
	}
}

// Shareable screen capture function
async function captureScreenshot(assetKey, timeframeKey, env) {
	const url = ASSET_URLS[assetKey] || ASSET_URLS["nasdaq100"];
	const label = TIMEFRAME_LABELS[timeframeKey] || TIMEFRAME_LABELS["1D"];

	const browser = await puppeteer.launch(env.MYBROWSER);
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1280, height: 800 });

		await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});

		// Hide overlays, cookies, consent banners, and popups
		try {
			await page.evaluate(() => {
				const style = document.createElement("style");
				style.textContent = `
					[class*="fc-consent"], [class*="qc-cmp"], #ez-accept-all, 
					[id^="sp_message"], .adblock-wall, [style*="z-index: 2"] {
						display: none !important;
						visibility: hidden !important;
					}
				`;
				document.head.appendChild(style);

				document.querySelectorAll('*').forEach(el => {
					const computed = window.getComputedStyle(el);
					if ((computed.position === 'fixed' || computed.position === 'sticky') && computed.zIndex > 10) {
						el.style.display = 'none';
					}
				});
				
				document.body.style.overflow = "auto";
				document.documentElement.style.overflow = "auto";
			});
			await new Promise((resolve) => setTimeout(resolve, 3000));
		} catch {
			// Ignore stylesheet injection failure
		}

		// Connect to the TradingView widget iframe and select timeframe
		try {
			const frame = page.frames().find(f => f.url().includes('s.tradingview.com/widgetembed') || f.url().includes('tradingview.com'));
			if (frame) {
				const dropdownSelector = '[aria-label="Chart interval"]';
				await frame.waitForSelector(dropdownSelector, { timeout: 8000 });
				await frame.click(dropdownSelector);
				await new Promise(r => setTimeout(r, 800)); // wait for dropdown animation

				await frame.evaluate((text) => {
					const items = Array.from(document.querySelectorAll('div[role="row"]'));
					const targetItem = items.find(el => el.textContent && el.textContent.includes(text));
					if (targetItem) {
						targetItem.click();
					}
				}, label);
				await new Promise((resolve) => setTimeout(resolve, 3000)); // let the chart redraw
			} else {
				// Fallback navigation
				await page.evaluate((text) => {
					const el = Array.from(document.querySelectorAll("button, a, span")).find(
						(n) => n.textContent && n.textContent.trim() === text,
					);
					if (el) el.click();
				}, label);
				await new Promise((resolve) => setTimeout(resolve, 2000));
			}
		} catch (err) {
			console.warn("Failed to toggle timeframe, returning fallback view:", err.message);
		}

		const screenshot = await page.screenshot({ type: "png" });
		return screenshot;
	} finally {
		if (browser) {
			try {
				await browser.close();
			} catch (closeError) {
				console.error("Failed to close browser:", closeError.message);
			}
		}
	}
}

export default {
	async fetch(request, env) {
		const { searchParams, pathname } = new URL(request.url);

		// 1. Status Endpoint
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

		// 2. Cleanup Endpoint
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
						// Ignored (session already closing)
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

		// 3. Keep-alive / live screenshot capture endpoint
		if (pathname === "/screenshot") {
			const asset = searchParams.get("asset") ?? "nasdaq100";
			const timeframe = searchParams.get("timeframe") ?? "1D";

			if (!ASSET_URLS[asset]) {
				return new Response(JSON.stringify({ error: `Invalid asset. Supported assets: ${Object.keys(ASSET_URLS).join(", ")}` }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}

			if (!TIMEFRAME_LABELS[timeframe]) {
				return new Response(JSON.stringify({ error: `Invalid timeframe. Supported: ${Object.keys(TIMEFRAME_LABELS).join(", ")}` }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			}

			const limitCheck = await checkLimits(env);
			if (!limitCheck.allowed) {
				return limitCheck.response;
			}

			try {
				const img = await captureScreenshot(asset, timeframe, env);
				return new Response(img, {
					headers: { "content-type": "image/png" },
				});
			} catch (error) {
				return new Response(JSON.stringify({ error: error.message, stack: error.stack }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		}

		// 4. Retrieve latest stored screenshot from KV
		if (pathname === "/latest") {
			const asset = searchParams.get("asset") ?? "nasdaq100";
			const timeframe = searchParams.get("timeframe") ?? "1D";

			if (!env.CHARTS_KV) {
				return new Response(JSON.stringify({ error: "CHARTS_KV namespace binding is not configured in this environment." }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}

			const latestKey = `${asset}/${timeframe}/latest.png`;
			try {
				const imageObject = await env.CHARTS_KV.get(latestKey, { type: "arrayBuffer" });
				if (!imageObject) {
					return new Response(JSON.stringify({ error: `No stored screenshot found for asset '${asset}' with timeframe '${timeframe}'.` }), {
						status: 404,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response(imageObject, {
					headers: { "content-type": "image/png" },
				});
			} catch (e) {
				return new Response(JSON.stringify({ error: e.message }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		}

		// Default overview route
		return new Response(
			JSON.stringify({
				message: "FX Daily Chart Worker is ready.",
				schedule: "07:00 UTC Mon-Fri",
				endpoints: {
					status: "/status",
					cleanup: "/cleanup",
					screenshot: "/screenshot?asset=[nasdaq100|gold]&timeframe=[30m|3h|1D|1W|1M|3M|1Y]",
					latest: "/latest?asset=[nasdaq100|gold]&timeframe=[30m|3h|1D|1W|1M|3M|1Y]"
				}
			}, null, 2),
			{ headers: { "content-type": "application/json" } }
		);
	},

	// 5. Cron Trigger implementation
	async scheduled(event, env, ctx) {
		console.log(`Cron trigger started at ${new Date().toISOString()}`);

		const runJob = async () => {
			const limitCheck = await checkLimits(env);
			if (!limitCheck.allowed) {
				console.error("Cron execution aborted due to browser daily resource limit.");
				return;
			}

			const assets = ["nasdaq100", "gold"];
			const timeframes = ["1D", "30m", "3h"];

			for (const asset of assets) {
				for (const timeframe of timeframes) {
					try {
						console.log(`Running scheduled capture for: ${asset} ${timeframe}`);
						const screenshot = await captureScreenshot(asset, timeframe, env);

						if (env.CHARTS_KV) {
							const dateStr = new Date().toISOString().split("T")[0];
							const historicalKey = `${asset}/${timeframe}/${dateStr}.png`;
							const latestKey = `${asset}/${timeframe}/latest.png`;

							// Put historical item
							await env.CHARTS_KV.put(historicalKey, screenshot, {
								customMetadata: { asset, timeframe, date: dateStr }
							});
							// Update latest item pointer
							await env.CHARTS_KV.put(latestKey, screenshot, {
								customMetadata: { asset, timeframe, date: dateStr }
							});
							console.log(`Saved screenshot to KV successfully: ${historicalKey}`);
						} else {
							console.warn("CHARTS_KV is not bound; screenshot was taken but not stored.");
						}
					} catch (err) {
						console.error(`Scheduled capture failed for ${asset}/${timeframe}: ${err.message}`);
					}
				}
			}
		};

		ctx.waitUntil(runJob());
	}
};
