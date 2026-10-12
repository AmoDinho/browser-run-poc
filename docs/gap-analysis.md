# Gap Analysis — shipped vs. outstanding

**Assessed against:** spec v4 (`docs/fx-chart-analyst-spec-v4-deepseek.md`). v3 is superseded. **Codebase:** `browser-run-hello-world`, branch `feature/real_stuff`.

---

## Headline

Your summary says "spec complete… only cosmetic cleanup and testing remaining." That's accurate **against `docs/fx_daily_chart_spec.md`**, which only ever described the capture stage. Measured against the actual product — screenshots analysed by a model grounded in a written method, output as a daily Markdown report — **the capture stage is roughly 70% done and the analysis and reporting stages are 0% done.** The build is in good shape; it's just earlier than "complete" suggests, because the spec it was measured against covered about a third of the product.

Two items inside the "complete" capture stage aren't cosmetic. They'd produce *wrong* output rather than no output, which is worse. Flagged 🔴.

---

## Stage 1 — Capture

| Requirement | Status | Notes |
|---|---|---|
| Browser Run + Puppeteer Worker | ✅ Done | Working, deployed-ready |
| Target asset URLs | ✅ Done | `ASSET_URLS` for nasdaq100 + gold |
| Cron `0 7 * * 1-5` + `scheduled()` | ✅ Done | 07:00 UTC = 09:00 SAST |
| TradingView iframe + interval toggle | ✅ Done | `[aria-label="Chart interval"]`, `div[role="row"]` text match, with fallback |
| KV persistence + `latest.png` pointer | ✅ Done | Custom metadata included |
| Free-tier limit guard + stale-session cleanup | ✅ Done | Beyond spec, genuinely useful |
| Ops endpoints `/status` `/cleanup` `/screenshot` `/latest` | ✅ Done | Beyond spec |
| **Three timeframes per asset per run** | ⚠️ Partial | Cron captures `1D`, `30m`, `3h` (6 PNGs) but in six sessions, with no `requested` vs `actual` record |
| **Intraday timeframes (`15m`, `3h`/`30m`)** | ⚠️ Partial | `30m` and `3h` are in `TIMEFRAME_LABELS` and the cron. `15m` is not, and is unverified in the widget |
| 🔴 **Chart-visibility assertion** | ❌ **Missing** | A blank or overlay-covered chart yields a valid PNG. Harmless when a human eyeballs it; dangerous once a model does |
| 🔴 **Interval-change verification** | ❌ **Missing** | A silent toggle failure gives three identical images described as three timeframes |
| Clip screenshot to chart element | ❌ Missing | Full-page shots feed nav/ads/footer into the model's context and inflate image tokens |
| One session per asset across all timeframes | ❌ Missing | A new browser per (asset, timeframe). Matters for the 10 min/day browser budget |
| Idempotency / `force` flag | ❌ Missing | Re-runs silently overwrite |

## Stage 2 — Grounding

| Requirement | Status |
|---|---|
| `knowledge/methodology.md` written (decision procedure, not raw PDFs) | ❌ Not started — **blocking, human-only** |
| Loaded into the system prompt; `PROMPT_VERSION` recorded on every report | ❌ Not started |
| Empty `method_citations` flagged in the run log and on the report | ❌ Not started |

*v4 dropped the vector store. There is no `file_search` call to log.*

## Stage 3 — Analysis

| Requirement | Status |
|---|---|
| Chat Completions client, per-request, `DEEPSEEK_API_KEY` | ❌ Not started |
| Inline base64 `image_url`, `detail: "original"`, user message only | ❌ Not started |
| `deepseek-flash`, thinking on, `reasoning_effort: high` | ❌ Not started |
| `response_format: json_object`, then Zod-parse; retry once | ❌ Not started |
| Usage, cache hit/miss, `reasoning_content`, `finish_reason` on `runs/…` | ❌ Not started |

## Stage 4 — Reporting

| Requirement | Status |
|---|---|
| `render.ts` JSON → Markdown | ❌ Not started |
| Report + run-log KV keys | ❌ Not started |
| `/reports` list + detail routes | ❌ Not started |
| `VIEWER_TOKEN` gating | ❌ Not started |
| Degraded-capture warning treatment | ❌ Not started |

## Stage 5 — Orchestration & hygiene

| Requirement | Status | Notes |
|---|---|---|
| Cron trigger | ✅ Done | |
| **Retries** | ❌ Missing | Bare `scheduled()` — a thrown error means no report until tomorrow. Analysis adds a model call and a Zod parse, so this stops being optional |
| Failure notification | ❌ Missing | Silent daily failure currently goes unnoticed indefinitely |
| Structured logging with `runId` | ❌ Missing | |
| **TypeScript** | ❌ Missing | Single `index.js`; no `tsconfig`, no `wrangler types`, no `Env` interface. Now CS-0 |
| Automated tests | ❌ Missing | `render.ts` and the Zod schema are pure — start there |
| Rename off `browser-run-hello-world` | ⚠️ Cosmetic | |
| README missing `/latest` | ⚠️ Cosmetic | |
| `.DS_Store` in `.gitignore` | ⚠️ Cosmetic | |

---

## Blocking decisions

1. **Timeframe set** (spec v4 §4.1) — A (intraday) / B (positional) / C (both). Current cron is `{1D, 30m, 3h}`.
2. **`knowledge/methodology.md`** — human-only, longest lead. Worth starting before any analysis code.
3. **One asset or both** during analysis bring-up — recommend gold only.

---

## Remaining change sets, in order

**CS-0 — TypeScript migration** *first*
Pure mechanical port of `index.js` to the `src/` layout in spec v4 §5a. `tsconfig` with `strict: true`, `wrangler types` → committed `worker-configuration.d.ts`, `tsc --noEmit` as a pre-deploy script. **No behaviour changes** — a language migration mixed with logic changes is unreviewable. Accept: `tsc --noEmit` clean; `wrangler dev --remote` boots; every existing endpoint behaves identically.

**CS-A — Capture hardening** 🔴 *next*
Visibility assertion, interval-change verification, clip-to-chart. Accept: a deliberately broken selector fails loudly instead of storing a grey PNG; three captured images are provably different.

**CS-B — Multi-timeframe cron**
Three timeframes per asset in one browser session; `requested` vs `actual` tracking; 3H→30M fallback; JSON manifest of keys; idempotency + `force`. Accept: 6 PNGs per run (2 assets × 3 TFs), visibly different ranges, total browser time under ~3 min checked against `puppeteer.limits()`.

**CS-C — Methodology prompt** *(parallel with A/B; human)*
Write `knowledge/methodology.md`: headings, decision order, what may be read off a chart, what must not be invented. Accept: the file is committed and cited by section heading from a hand-written fixture report.

**CS-D — Reporting surface**
`render.ts` + KV keys + `/reports` routes + token gating, driven by a hand-authored fixture JSON. Accept: fixture report readable in a browser, images load, unauthenticated → 404. *Deliberately before the model work — gives the analysis output somewhere to land and proves the render layer independently.*

**CS-E — DeepSeek analysis**
Chat Completions to `deepseek-flash`: per-request client, base64 images from KV, `json_object` plus Zod-parse, retry once on empty content, truncation, or schema failure. Log usage, cache hit/miss, and `reasoning_content`. Wire to `POST /analyse?asset=…&date=…&force=1`.

Accept: coherent report from real screenshots with non-empty `method_citations`; **and** a deliberately blank image yields `capture_quality: "poor"` rather than confident fiction. Calibrate against a human read of the same charts. If the read is weak, raise `reasoning_effort` to `max`. Do not switch to `deepseek-v4-pro` (no vision).

**CS-F — Orchestration**
Migrate `scheduled()` to a Cloudflare Workflow with per-step retries (capture → analyse → persist), cron on the Workflow binding. Keep manual `/run` permanently as the debug entry point. Accept: a forced failure in the analyse step retries without re-running the browser step.

**CS-G — Hygiene**
Rename, README, `.gitignore`, `runId` logging, failure webhook, unit tests for `render.ts` + schema validator.

---

## One estimate

CS-0: an hour or two, one file. CS-A and CS-B: half a day. CS-D: half a day. CS-E: a day, most of it prompt iteration rather than code. CS-F: a few hours. CS-C is however long it takes you to decide what the methodology actually is — the real critical path, and the only item on this list no agent can do for you.
