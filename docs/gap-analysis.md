# Gap Analysis — shipped vs. outstanding

**Assessed against:** spec v3 (OpenAI + AI SDK 7, TypeScript). **Codebase:** `browser-run-hello-world`, branch `feature/real_stuff`.

---

## Headline

Your summary says "spec complete… only cosmetic cleanup and testing remaining." That's accurate **against `docs/fx_daily_chart_spec.md`**, which only ever described the capture stage. Measured against the actual product — screenshots analysed by a model grounded in trading textbooks, output as a daily Markdown report — **the capture stage is roughly 70% done and the analysis and reporting stages are 0% done.** The build is in good shape; it's just earlier than "complete" suggests, because the spec it was measured against covered about a third of the product.

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
| **Three timeframes per asset per run** | ❌ **Missing** | Cron captures **1D only**. Multi-timeframe exists on-demand via `/screenshot` but the scheduled path never exercises it. This is the input the entire analysis stage consumes |
| **Intraday timeframes (`15M`, `3H`/`30M`)** | ❌ **Missing** | `TIMEFRAME_LABELS` has 1D/1W/1M/3M/1Y only; intraday labels unverified |
| 🔴 **Chart-visibility assertion** | ❌ **Missing** | A blank or overlay-covered chart yields a valid PNG. Harmless when a human eyeballs it; dangerous once a model does |
| 🔴 **Interval-change verification** | ❌ **Missing** | A silent toggle failure gives three identical images described as three timeframes |
| Clip screenshot to chart element | ❌ Missing | Full-page shots feed nav/ads/footer into the model's context and inflate image tokens |
| One session per asset across all timeframes | ⚠️ Partial | Single-TF cron means this is untested; matters for the 10 min/day browser budget |
| Idempotency / `force` flag | ❌ Missing | Re-runs silently overwrite |

## Stage 2 — Grounding

| Requirement | Status |
|---|---|
| Textbook PDFs selected | ❌ Not started — **blocking, human-only** |
| `scripts/setup-vector-store.mjs` (upload, create store, poll to `completed`) | ❌ Not started |
| `OPENAI_VECTOR_STORE_ID` in config, `knowledge/manifest.json` committed | ❌ Not started |
| `file_search_call` logging so ungrounded runs are visible | ❌ Not started |

*Cheaper than it was under v2 — `file_search` takes the PDFs natively, so no distillation pipeline is needed.*

## Stage 3 — Analysis

| Requirement | Status |
|---|---|
| `ai` + `@ai-sdk/openai` + `zod` installed; provider built per-request from `env` | ❌ Not started |
| `uploadFile` → `ProviderReference` per screenshot, persisted | ❌ Not started |
| `generateText` on `openai.responses(gpt-5.6-luna)` with `fileSearch` tool | ❌ Not started |
| Zod schema as single source of truth + `Output.object()` | ❌ Not started |
| **Verified: `file_search` call *and* valid object in the same request** (§6.5) | ❌ Not started — decides single- vs two-call design |
| `NoObjectGeneratedError` handling + retry-once | ❌ Not started |
| Grounding trail logging (`include: ['file_search_call.results']`) | ❌ Not started |
| Token usage / latency logging | ❌ Not started |
| `OPENAI_API_KEY` secret | ❌ Not started |

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
| **Retries** | ❌ Missing | Bare `scheduled()` — a thrown error means no report until tomorrow. The analysis stage roughly triples the failure surface (upload, model call, validation), so this stops being optional |
| Failure notification | ❌ Missing | Silent daily failure currently goes unnoticed indefinitely |
| Structured logging with `runId` | ❌ Missing | |
| **TypeScript** | ❌ Missing | Single `index.js`; no `tsconfig`, no `wrangler types`, no `Env` interface. Now CS-0 |
| Automated tests | ❌ Missing | `render.ts` and the Zod schema are pure — start there |
| Rename off `browser-run-hello-world` | ⚠️ Cosmetic | |
| README missing `/latest` | ⚠️ Cosmetic | |
| `.DS_Store` in `.gitignore` | ⚠️ Cosmetic | |

---

## Blocking decisions

1. **Timeframe set** (spec v3 §4.1) — A (intraday) / B (positional, works today) / C (both). Blocks CS-A.
2. **The textbooks** — needed for CS-C. Human-only, longest lead. Worth starting before any code.
3. **One asset or both** during analysis bring-up — recommend gold only.

---

## Remaining change sets, in order

**CS-0 — TypeScript migration** *first*
Pure mechanical port of `index.js` to the `src/` layout in spec v3 §5a. `tsconfig` with `strict: true`, `wrangler types` → committed `worker-configuration.d.ts`, `tsc --noEmit` as a pre-deploy script. **No behaviour changes** — a language migration mixed with logic changes is unreviewable. Accept: `tsc --noEmit` clean; `wrangler dev --remote` boots; every existing endpoint behaves identically.

**CS-A — Capture hardening** 🔴 *next*
Visibility assertion, interval-change verification, clip-to-chart. Accept: a deliberately broken selector fails loudly instead of storing a grey PNG; three captured images are provably different.

**CS-B — Multi-timeframe cron**
Three timeframes per asset in one browser session; `requested` vs `actual` tracking; 3H→30M fallback; JSON manifest of keys; idempotency + `force`. Accept: 6 PNGs per run (2 assets × 3 TFs), visibly different ranges, total browser time under ~3 min checked against `puppeteer.limits()`.

**CS-C — Vector store** *(parallel with A/B; mostly human)*
Choose PDFs, write and run `setup-vector-store.mjs`, commit the manifest. Accept: a standalone `file_search` smoke call answers a question only answerable from the PDFs; re-running the script doesn't duplicate files.

**CS-D — Reporting surface**
`render.ts` + KV keys + `/reports` routes + token gating, driven by a hand-authored fixture JSON. Accept: fixture report readable in a browser, images load, unauthenticated → 404. *Deliberately before the model work — gives the analysis output somewhere to land and proves the render layer independently.*

**CS-E — OpenAI analysis**
AI SDK integration: per-request provider, `uploadFile` for the three screenshots, `generateText` on `openai.responses('gpt-5.6-luna')` with the `fileSearch` tool and `Output.object()` over the Zod schema, `NoObjectGeneratedError` handling, grounding-trail and usage logging. Wire to `POST /analyse?asset=…&date=…&force=1`.

**Do the §6.5 combination check before anything else in this change set:** assert from the logged steps that a `file_search` call happened *and* a schema-valid object came back in the same request. If marginal, switch to the two-call design (grounded prose, then `generateObject` shaping) and move on — it's pre-specified, costs fractions of a cent extra, and is the expected outcome rather than a setback.

Accept: coherent report from real screenshots with non-empty `doc_citations`; **and** a deliberately blank image yields `capture_quality: "poor"` rather than confident fiction. Both halves required — the negative case proves the grounding and honesty instructions actually landed.

Includes a one-off **tier calibration**: same six screenshots through `gpt-5.6-luna` and `gpt-5.6-terra`, compared against your own reading of the charts. Costs cents; decides the tier with evidence. Try `reasoning_effort: high` on Luna before escalating.

**CS-F — Orchestration**
Migrate `scheduled()` to a Cloudflare Workflow with per-step retries (capture → upload → analyse → persist), cron on the Workflow binding. Keep manual `/run` permanently as the debug entry point. Accept: a forced failure in the analyse step retries without re-running the browser step.

**CS-G — Hygiene**
Rename, README, `.gitignore`, `runId` logging, failure webhook, unit tests for `render.ts` + schema validator.

---

## One estimate

CS-0: an hour or two, one file. CS-A and CS-B: half a day. CS-D: half a day. CS-E: a day, most of it prompt iteration rather than code. CS-F: a few hours. CS-C is however long it takes you to decide what the methodology actually is — the real critical path, and the only item on this list no agent can do for you.
