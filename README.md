# FX Chart Analyst

Cloudflare Worker that captures Nasdaq 100 and gold charts and writes a DeepSeek vision report. Capture and analysis run as separate steps in `DailyAnalysisWorkflow`, not inside one `scheduled()` call.

The Worker name is `fx-chart-analyst` (previously `browser-run-hello-world`). Deploying creates or updates that script. The existing `CHARTS_KV` namespace id is unchanged.

## Decisions

- Timeframes per asset: `1D`, `30m`, `3h`. `15m` is not in the widget label map, so it is not requested. If `3 hours` is absent, capture falls back to `30 minutes` and records that.
- Both `nasdaq100` and `gold` run on the weekday cron.
- Model is `deepseek-flash` only. Vision calls are raw `POST https://api.deepseek.com/chat/completions`.
- `knowledge/methodology.md` is a placeholder decision procedure. A human has to replace it before a report is treated as method-grounded.

## Endpoints

- `GET /status` — browser limits and sessions
- `GET /cleanup` — close abandoned browser sessions
- `GET /screenshot?asset=nasdaq100|gold&timeframe=30m|3h|1D|1W|1M|3M|1Y` — one clipped screenshot
- `GET /latest?asset=…&timeframe=…` — latest stored PNG
- `GET /reports?token=…` — report dates, newest first
- `GET /reports/:asset/:date?token=…` — report HTML
- `GET /reports/:asset/:date/:tf.png?token=…` — stored PNG for that date
- `GET|POST /run?token=…&force=1` — capture then analyse. Cron never sends `force=1`
- `GET|POST /analyse?token=…&asset=gold&date=YYYY-MM-DD&force=1` — re-encode PNGs from KV. No recapture

Wrong or missing `token` on `/reports`, `/run`, and `/analyse` is **404**, not 401.

## Secrets

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put VIEWER_TOKEN
npx wrangler secret put FAILURE_WEBHOOK_URL
```

`FAILURE_WEBHOOK_URL` is optional. `DEEPSEEK_MODEL` and `DEEPSEEK_REASONING_EFFORT` are vars (`deepseek-flash`, `high`). Wrangler needs Node 22.

```bash
yarn install
yarn typecheck
yarn test
yarn dev
yarn deploy
```
