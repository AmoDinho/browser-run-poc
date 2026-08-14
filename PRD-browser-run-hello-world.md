# PRD: LiveCharts GBP/USD Screenshot Bot — Browser Run "Hello World"

## 1. Summary
A minimal demo of Cloudflare's **Browser Run** (formerly called Browser Rendering) that opens the GBP/USD forex chart on livecharts.co.uk, switches the timeframe, and returns a screenshot — all from a single Cloudflare Worker.

## 2. Goal
Prove the Browser Run + Puppeteer workflow end to end with the smallest possible slice: one page, one currency pair, one timeframe toggle, one screenshot. Nothing fancier until this works.

## 3. Background
- **Browser Run** lets a Cloudflare Worker drive a real headless Chromium instance in Cloudflare's network — no servers to manage.
- Two ways to use it:
  - **Quick Actions** — single HTTP call, no code deploy, good for "just get me a screenshot."
  - **Browser Sessions** (Puppeteer / Playwright / CDP) — full scripted control: navigate, click, wait, screenshot. This is what we need since we have to click a timeframe toggle first.

## 4. User story
As a developer testing Browser Run, I want to hit a URL and get back an image of the GBP/USD live chart on a timeframe I choose, so I can confirm the headless browser can navigate a real third-party site, interact with it, and capture what it sees.

## 5. Scope

**In scope (v0):**
- One Worker, one GET endpoint
- Navigate to `https://www.livecharts.co.uk/ForexCharts/gbpusd.php`
- Accept a `?timeframe=` query param (e.g. `1D`, `1W`, `1M`)
- Best-effort dismiss of any cookie/consent banner
- Click the matching timeframe control on the page
- Screenshot the page, return it directly as the HTTP response (`image/png`)
- Runs locally via `wrangler dev --remote` and deploys via `wrangler deploy`

**Out of scope (v0 — fast-follows if this works):**
- Other currency pairs, multi-pair dashboard
- Reading the actual price/OHLC data out of the chart (OCR or DOM scraping)
- Caching screenshots in KV (Cloudflare's own docs show this pattern — easy to bolt on later)
- Auth, rate limiting, custom domains
- Pixel-perfect handling of every possible consent-banner variant

## 6. Technical approach
- **Product:** Cloudflare Browser Run, Browser Sessions mode
- **Library:** `@cloudflare/puppeteer` (Cloudflare's own Puppeteer fork, built for the Workers binding)
- **Runtime:** Cloudflare Workers, `browser` binding
- Suggested build order:
  1. **Phase 0 — true hello world:** call the Quick Actions screenshot endpoint against `example.com` (or livecharts, no interaction) just to prove your account/binding/token works.
  2. **Phase 1 — the real ask:** swap in the Puppeteer Browser Sessions code below, which navigates, clicks a timeframe button, and screenshots.

## 7. Setup steps (from Cloudflare's current docs)

1. **Cloudflare account** — sign up free at the Workers dashboard if you don't have one.
2. **Node.js** installed (16.17+; a version manager like `nvm` or `volta` is recommended).
3. **Scaffold the Worker:**
   ```
   npm create cloudflare@latest -- browser-run-hello-world
   ```
   Choose: *Hello World example* → *Worker only* → *JavaScript* → git yes → deploy no (we'll edit first).
4. **Install Cloudflare's Puppeteer fork:**
   ```
   npm i -D @cloudflare/puppeteer
   ```
5. **Add the browser binding** to `wrangler.jsonc` (see the starter project — `browser: { binding: "MYBROWSER" }`).
6. **Drop in the code** from the starter project (`src/index.js`).
7. **Test locally** (uses a real remote browser, not a mock):
   ```
   npx wrangler dev --remote
   ```
   Visit `http://localhost:8787/?timeframe=1D`.
8. **Deploy:**
   ```
   npx wrangler deploy
   ```
   Visit `https://<your-worker>.<your-subdomain>.workers.dev/?timeframe=1D`.

Free Workers plan includes Browser Run with a small concurrency limit (a couple of browsers per minute) — plenty for this test.

## 8. Risks / open questions
- **Unknown selector:** livecharts.co.uk's chart is a rendered widget, so the exact button/label for each timeframe can't be determined from a static page fetch. The starter code clicks by *visible text* (e.g. "1D") as a best-effort approach — **you'll need to open the page in a real browser once, inspect the timeframe control, and confirm or adjust the label/selector.**
- **Consent banner:** the site shows a "Privacy Manager" / cookie prompt on first load; the starter code makes a best-effort attempt to dismiss common patterns, but this may need a tweak once you see the real banner.
- **Bot detection:** Cloudflare notes that Bot Management products can flag Browser Run traffic by default; irrelevant for a personal test but worth knowing if you later point this at a site with bot protection.

## 9. Acceptance criteria
- [ ] Hitting the deployed Worker URL returns a valid PNG image
- [ ] The image visibly shows the GBP/USD chart from livecharts.co.uk
- [ ] Changing `?timeframe=` visibly changes the chart range in the screenshot
- [ ] Works both via `wrangler dev --remote` locally and the deployed `workers.dev` URL

## 10. Effort estimate
Well under an hour — it's mostly Cloudflare's own quickstart plus one extra click step.
