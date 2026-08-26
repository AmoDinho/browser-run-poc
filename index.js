import puppeteer from "@cloudflare/puppeteer";

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
		// Auto-cleanup stale sessions if we're hitting the concurrency limit (max 3 for free tier)
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

export default {
	async fetch(request, env) {
		const { searchParams, pathname } = new URL(request.url);

		// 1. Status Check Endpoint
		if (pathname === "/status") {
			try {
				const limits = await puppeteer.limits(env.MYBROWSER);
				const sessions = await puppeteer.sessions(env.MYBROWSER);
				return new Response(JSON.stringify({ limits, sessions }, null, 2), {
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				return new Response(JSON.stringify({ error: e.message }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		}

		// 2. Cleanup Endpoint (Manually close hung browser sessions)
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
				return new Response(JSON.stringify({ message: `Successfully closed ${closed.length} sessions`, closed }, null, 2), {
					headers: { "content-type": "application/json" },
				});
			} catch (e) {
				return new Response(JSON.stringify({ error: e.message }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		}

		// 3. Main Chart Screenshot Logic Placeholder
		if (pathname === "/screenshot") {
			const limitCheck = await checkLimits(env);
			if (!limitCheck.allowed) {
				return limitCheck.response;
			}

			let browser = null;
			try {
				browser = await puppeteer.launch(env.MYBROWSER);
				const page = await browser.newPage();
				await page.setViewport({ width: 1280, height: 800 });

				// TODO: Implement the specific daily chart navigation, interaction and capture
				// logic once the target spec requirements are confirmed.
				// Example:
				// await page.goto("https://target-url.com");
				// await page.screenshot({ type: "png" });

				return new Response(
					JSON.stringify({
						message: "Ready to capture daily charts. Please upload the proper spec to continue.",
						status: "initialized"
					}),
					{ headers: { "content-type": "application/json" } }
				);
			} catch (error) {
				return new Response(
					JSON.stringify({
						error: error.message,
						details: "Browser execution failed during screenshot capture.",
					}),
					{ status: 500, headers: { "content-type": "application/json" } }
				);
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

		// Default Route
		return new Response(
			JSON.stringify({
				message: "FX Daily Chart Worker is ready.",
				endpoints: {
					status: "/status",
					cleanup: "/cleanup",
					screenshot: "/screenshot"
				}
			}, null, 2),
			{ headers: { "content-type": "application/json" } }
		);
	},
};
