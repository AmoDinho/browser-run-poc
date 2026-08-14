# Browser Run Hello World — LiveCharts GBP/USD

A minimal Cloudflare Worker using Browser Run (Puppeteer) to screenshot the
GBP/USD chart on livecharts.co.uk at a chosen timeframe.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Log in to Cloudflare (one-time):
   ```
   npx wrangler login
   ```
3. Run locally against a real remote browser:
   ```
   npm run dev
   ```
   Then open: `http://localhost:8787/?timeframe=1D`

4. Deploy:
   ```
   npm run deploy
   ```
   Then open: `https://browser-run-hello-world.<your-subdomain>.workers.dev/?timeframe=1D`

## Before you rely on this

Open `https://www.livecharts.co.uk/ForexCharts/gbpusd.php` in a normal
browser, right-click the timeframe buttons (1D / 1W / 1M etc.), and choose
"Inspect" to confirm the exact text or selector. Update `TIMEFRAME_LABELS`
in `src/index.js` if the real labels differ from the guesses in this
starter (the click-by-visible-text approach is a best-effort placeholder).

Also check whether a cookie/consent banner appears on first load — if the
dismiss logic in `src/index.js` doesn't match it, screenshots will still
work, they'll just show the banner over the chart.

## Query params

- `timeframe` — one of `1D`, `1W`, `1M`, `3M`, `1Y` (defaults to `1D`)
