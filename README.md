# FX Chart Analyst

Cloudflare Worker that captures Nasdaq 100 and gold charts and writes a DeepSeek vision report. Capture and analysis run as separate steps in `DailyAnalysisWorkflow`, not inside one `scheduled()` call.

The Worker name is `fx-chart-analyst` (previously `browser-run-hello-world`). Deploying creates or updates that script. The existing `CHARTS_KV` namespace id is unchanged.

## Decisions

- Timeframes per asset: `1D`, `30m`, `3h`. `15m` is not in the widget label map, so it is not requested. If `3 hours` is absent, capture falls back to `30 minutes` and records that.
- Both `nasdaq100` and `gold` run on the weekday cron.
- Model is `deepseek-flash` only. Vision calls are raw `POST https://api.deepseek.com/chat/completions`.
- `knowledge/methodology.md` is the decision procedure (order-flow prompt). `knowledge/context.md` is separate reference notes. Both are loaded into the system message. The decision procedure wins if they conflict.

## Endpoints

- `GET /status` — browser limits and sessions
- `GET /cleanup` — close abandoned browser sessions
- `GET /screenshot?asset=nasdaq100|gold&timeframe=30m|3h|1D|1W|1M|3M|1Y` — one clipped screenshot
- `GET /latest?asset=…&timeframe=…` — latest stored PNG
- `GET /reports?token=…` — report dates, newest first
- `GET /reports/:asset/:date?token=…` — report HTML
- `GET /reports/:asset/:date/:tf.png?token=…` — stored PNG for that date
- `GET /brief/:asset/:date?token=…` — phone brief written after a successful analysis
- `GET|POST /run?token=…&force=1` — capture then analyse. Cron never sends `force=1`
- `GET|POST /analyse?token=…&asset=gold&date=YYYY-MM-DD&force=1` — re-encode PNGs from KV. No recapture

The weekday cron (`cron-YYYY-MM-DD`) writes the brief, then sends one Telegram message. A manual `/run` or `/analyse` writes the brief and does not ping.

Wrong or missing `token` on `/reports`, `/brief`, `/run`, and `/analyse` is **404**, not 401.

## Secrets

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put VIEWER_TOKEN
npx wrangler secret put FAILURE_WEBHOOK_URL
```

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `PUBLIC_ORIGIN` are GitHub repo secrets. Deploy uploads them. `PUBLIC_ORIGIN` is the worker origin with no trailing slash. `FAILURE_WEBHOOK_URL` is optional. Without the Telegram secrets the morning step logs `telegram.skipped` and does not fail the run. `DEEPSEEK_MODEL` and `DEEPSEEK_REASONING_EFFORT` are vars (`deepseek-flash`, `high`). Wrangler needs Node 22.

```bash
yarn install
yarn typecheck
yarn test
yarn dev
yarn deploy
```
