# Daily Chart Analyst — Implementation Plan

Plan for taking the `browser-run-hello-world` Worker to the product described in `fx-chart-analyst-spec-v4-deepseek.md` ("spec v4"). v3 is superseded. Sequenced from the outstanding work in `gap-analysis.md`.

## Current state (reconciled with `feature/real_stuff` HEAD `81462ff`)

The gap analysis was written before the last capture commit. Actual state now:

- **Capture**: Browser + Puppeteer works; cron `0 7 * * 1-5`; assets `nasdaq100` + `gold`; KV persistence with `latest.png` pointers; free-tier guard + stale-session cleanup; ops endpoints `/status` `/cleanup` `/screenshot` `/latest`. All present.
- **Ahead of the docs**: the cron already captures three timeframes per asset (`1D`, `30m`, `3h` → 6 PNGs/run) and `TIMEFRAME_LABELS` already includes intraday keys. But it launches a fresh browser session per (asset, timeframe), does **not** verify the toggle took effect, and records no `requested` vs `actual` state.
- **Missing from capture**: chart-visibility assertion, interval-change verification, clip-to-chart, one session per asset, idempotency/`force`, per-run manifest.
- **Not started**: TypeScript migration (CS-0), methodology prompt (CS-C), reporting surface (CS-D), DeepSeek analysis (CS-E), Workflow orchestration + retries (CS-F), hygiene (CS-G). The whole project is one plain-JS `index.js`.

## Phasing

Phases are ordered so each builds on reviewable foundations: TS first (CS-0), then capture correctness (CS-A, CS-B), then the reporting surface before any model work (CS-D), then the methodology prompt (CS-C) and analysis (CS-E), then orchestration (CS-F), then hygiene (CS-G). CS-C is the only change set with a human-only critical path (writing `knowledge/methodology.md`) and should start as early as the method is known; it is otherwise parallel to CS-A/B/D.

### Phase 1 — CS-0: TypeScript migration

Scope:

- Mechanical port of `index.js` into the spec v4 §5a layout, no behaviour changes:
  - `src/index.ts` — fetch/scheduled handlers, routing only
  - `src/capture/browser.ts` — session, consent dismissal, interval switching, screenshots
  - `src/capture/config.ts` — asset + timeframe config (moved from module constants)
  - `src/storage/kv.ts` — key builders + get/put/list helpers (grows in later phases)
- `tsconfig.json` with `strict: true`; `wrangler types` generates and commits `worker-configuration.d.ts`.
- `package.json` gains `typecheck: tsc --noEmit`; add typecheck to the pre-deploy path.
- Env typed via generated `Env` interface; keep runtime behaviour byte-identical.

Acceptance:

- `tsc --noEmit` clean under `strict`.
- `wrangler dev --remote` boots; `/status`, `/screenshot`, `/latest`, `/cleanup` behave identically to pre-migration.
- Commit is a pure port — diff reviewable as moves/renames only.

### Phase 2 — CS-A: capture hardening

Scope (in `src/capture/browser.ts`):

- **Chart-visibility assertion**: before screenshot, assert the chart element's bounding box exceeds roughly 600×300; fail loudly on blank/overlay-covered chart instead of storing a grey PNG.
- **Interval-change verification**: after selecting a timeframe, confirm the change actually took effect — read the widget's interval label back and/or compare a perceptual hash of consecutive screenshots; three captured images must be provably different.
- **Clip to chart element**: screenshot only the chart box (~1200×700 target) so nav/ads/footer don't enter the model's context.

Acceptance:

- A deliberately broken selector fails the run (no silent grey PNG stored).
- Three captured images for one asset are provably different (hash check in the run log).

### Phase 3 — CS-B: multi-timeframe cron, finished to spec

Current code captures 1D/30m/3h but in six independent sessions. Bring it to spec:

- **One browser session per asset** across all its timeframes (2 sessions per run instead of 6) — keep within the ~10 min/day free-tier budget.
- **`requested` vs `actual` timeframes**: the report states what was *actually* captured, never what was requested; record `requested_timeframes` and `actual_timeframes` per asset in the run log.
- **Timeframe fallback**: 3H → 30M fallback when a label is absent, recording which was used.
- **JSON manifest of keys** written per run so the set of produced keys is traceable.
- **Idempotency + `force`**: re-running on the same date skips unless `force=1`; forced runs overwrite.
- Timeframe set itself is an open decision (see below); final config lives in `src/capture/config.ts`.

Acceptance:

- 6 PNGs per run (2 assets × 3 TFs), visibly different ranges.
- Manifest JSON lists every key written; second run of the same date is a no-op without `force`.
- Total browser time under ~3 min checked against `puppeteer.limits()`.

### Phase 4 — CS-D: reporting surface (before model work)

Deliberately before CS-E so analysis output has somewhere to land and the render layer is proven independently.

Scope:

- `src/report/render.ts` — pure `(ChartAnalysis) => string` JSON → Markdown; no network; unit-testable; re-runnable over stored JSON.
- KV keys: `reports/{asset}/{date}.json`, `reports/{asset}/{date}.md`; run log key `runs/{asset}/{date}.json`.
- Routes in `src/index.ts`:
  - `GET /reports?token=…` — list dates, newest first
  - `GET /reports/:asset/:date?token=…` — Markdown rendered to HTML
  - `GET /reports/:asset/:date/:tf.png?token=…` — generalise the existing `/latest` handler
- `VIEWER_TOKEN` gating: wrong or missing token → **404**, not 401.
- Degraded-capture treatment: `capture_quality: "poor"` renders a warning block at the top and suppresses the bias line; disclaimer footer on every report.
- Driven initially by a hand-authored fixture JSON (no model call needed).

Acceptance:

- Fixture report is readable in a browser; embedded PNGs load from KV.
- Unauthenticated access to any `/reports` route → 404.
- `render.ts` unit tests pass over fixture including the `poor`-quality path.

### Phase 5 — CS-C: methodology prompt (parallel; human critical path)

Scope:

- Human: write `knowledge/methodology.md` — section headings, decision order, what to read off a chart, what must not be invented. PDFs stay out of the repo and the Worker.
- `src/analysis/prompt.ts` loads that file into the system prompt and stamps `PROMPT_VERSION`.

Acceptance:

- The file is committed.
- A fixture report cites section headings from it.
- No vector-store script, no `OPENAI_VECTOR_STORE_ID`.

### Phase 6 — CS-E: DeepSeek analysis

Scope:

- Chat Completions at `https://api.deepseek.com/chat/completions`. SDK only if the wire format matches; otherwise `fetch`.
- Client built per request from `env.DEEPSEEK_API_KEY`. No module-scope `process.env`.
- `DEEPSEEK_API_KEY` as a Worker secret; `DEEPSEEK_MODEL` (`deepseek-flash`) and `DEEPSEEK_REASONING_EFFORT` (`high`) as vars.
- Per screenshot: PNG bytes from KV or the capture step, base64 `image_url`, `detail: "original"`, user message only. No Files API, no `ProviderReference`.
- `response_format: { type: "json_object" }`, then Zod-parse. Retry once on empty content, `finish_reason: "length"`, or schema failure. Do not use `Output.object()`.
- Log usage, `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, `reasoning_content`, and `finish_reason` to `runs/{asset}/{date}.json`. Flag empty `method_citations`.
- Wire `POST /analyse?asset=…&date=…&force=1`. Re-analysis re-encodes PNGs from KV.

Acceptance:

- Coherent report from real screenshots with non-empty `method_citations`.
- Deliberately blank image yields `capture_quality: "poor"`, not confident fiction.
- Calibration note recorded against a human read. Weak read → `reasoning_effort: max`, not a model change.

### Phase 7 — CS-F: orchestration with retries

Scope:

- Migrate `scheduled()` into a Cloudflare Workflow (`src/workflow.ts`, `DailyAnalysisWorkflow`) with per-step retries: capture → analyse → persist.
- Cron binds to the Workflow trigger; keep manual `/run` permanently as the debug entry point (in addition to `/analyse`).

Acceptance:

- A forced failure in the analyse step retries without re-running the browser step.
- A failed run writes its error to `runs/…` and can be re-driven manually.

### Phase 8 — CS-G: hygiene

Scope:

- Rename off `browser-run-hello-world` (wrangler name, package name).
- README: document `/latest` plus `/reports`, tokens, and the `/run` debug path.
- `.gitignore`: add `.DS_Store` (and untrack the committed one).
- Structured logging with a per-run `runId`; failure notification (webhook) when a daily run fails or captures poor.
- Unit tests for `render.ts` and the Zod schema validator.
- Bundle-size check after SDK additions (`wrangler deploy --dry-run --outdir dist`).

Acceptance:

- Worker deploys under the new name; typecheck + tests pass; README covers all endpoints.
- A deliberately failed run produces a `runId`-tagged log entry and a notification.

## Open decisions

1. **Timeframe set** (spec v4 §4.1; blocks CS-B config). Current cron captures `{1D, 30m, 3h}`. Options: A intraday `{1D, 3h, 15m}` (3h → 30m fallback) — recommended given the 07:00 weekday cadence; B positional `{1Y, 3M, 1D}`; C both (5 images). `15m` is not in `TIMEFRAME_LABELS` and needs verification inside the widget.
2. **Methodology text** (blocks a meaningful CS-E). Human-only, longest lead — start as early as possible.
3. **Bring-up asset** (spec v4 §9.3): recommend `gold` only during CS-E bring-up, both assets for the scheduled path.
4. **Model**: `deepseek-flash` only. `deepseek-v4-pro` has no vision.
