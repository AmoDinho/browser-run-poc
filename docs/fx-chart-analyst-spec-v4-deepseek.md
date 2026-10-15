# Spec v4: Daily Chart Analyst — DeepSeek vision

**Supersedes:** v3 (`docs/fx-chart-analyst-spec-v3-openai.md`). Do not implement v3.
**Reconciled against:** the shipped `browser-run-hello-world` Worker (`index.js`), and `docs/fx_daily_chart_spec.md`.
**Status:** capture stage partial; analysis and reporting not started.

v3 grounded the model with OpenAI hosted `file_search` over textbook PDFs. That path is dropped. Vision is DeepSeek Chat Completions (`deepseek-flash`). The methodology lives in the system prompt, not in a vector store.

---

## 1. What this version settles

| Decision | Choice |
|---|---|
| Language | **TypeScript**, whole project |
| Analysis API | **Chat Completions** at `https://api.deepseek.com`. Not Responses, not the Anthropic-compatible endpoint |
| Model | `deepseek-flash` (DeepSeek-V4.1-Flash). Do not configure `deepseek-v4-flash` or `deepseek-v4-flash-vision-exp` — both are retired aliases |
| Images | Inline base64 `image_url` data URLs, `detail: "original"`, **user message only** |
| Grounding | Committed methodology prompt (`knowledge/methodology.md`). No vector store, no `file_search`, no Files API |
| Assets | `nasdaq100`, `gold` — as shipped |
| Storage | **KV** (`CHARTS_KV`) — as shipped |
| Cron | `0 7 * * 1-5` UTC — as shipped |
| Structured output | `response_format: { type: "json_object" }`, then Zod-parse. DeepSeek does not enforce a schema |

`deepseek-v4-pro` has no vision. There is no second chart-reading tier to calibrate against. If `high` misreads charts, raise `reasoning_effort` to `max` and compare against a human read of the same screenshots. Do not switch to Pro.

Two constraints from the DeepSeek vision guide are load-bearing:

1. Images in `system` or `assistant` messages return **400**. The methodology prompt is text. Screenshots go in the user message.
2. `detail: "low"` downscales to 512×512. That destroys wick and axis detail. Use `"original"`. (`"high"` is equivalent today; `"auto"` is equivalent today. Set `"original"` so a future change to `auto` cannot silently downscale charts.)

---

## 2. Target state

```
cron 0 7 * * 1-5 (UTC)
   │
   ├─ for each asset [nasdaq100, gold]:
   │     one browser session ──▶ 3 screenshots (§4.1) ──▶ KV
   │
   ├─ read PNG bytes from KV (or from the capture step)
   │     base64 data URLs, detail "original"
   │
   ├─ POST /chat/completions
   │     model: deepseek-flash
   │     system: methodology + JSON contract (text only, stable)
   │     user: labelled images, then run context (last)
   │     response_format: json_object
   │     thinking enabled, reasoning_effort high
   │        │
   │        ▼
   │     Zod-parse ──▶ retry once on empty content, truncation, or schema failure
   │
   └─ render Markdown ──▶ KV ──▶ served at /reports
```

Six browser launches plus a thinking-mode completion will not fit one `scheduled()` invocation. Capture and analysis are separate steps (CS-F). The diagram is the pipeline, not one function.

---

## 3. Grounding

### 3.1 Methodology prompt — the corpus

`knowledge/methodology.md`, committed, loaded into the system prompt at build or request time. This replaces the v3 vector store.

The file is a decision procedure, not a pasted textbook:

- Section headings the model can cite.
- Order of work: longest timeframe for context, shortest for timing, then agreement and invalidation.
- What to read off a chart (structure, levels, wick extremes) and what must not be invented (indicator values that are not drawn).
- Explicit "if the documents do not cover this, say so" rule. The prompt is the only document.

`PROMPT_VERSION` is recorded on every report. Bump it when `methodology.md` or the contract in `src/analysis/prompt.ts` changes.

PDFs do not enter the Worker, git, or the request. If a textbook is the source of the method, a human distils it into `methodology.md` before any analysis code runs. That distillation is the longest-lead item and the only one no agent can do.

### 3.2 Citations are prompt adherence, not retrieval

There is no search call to log. The schema field is `method_citations: [{ claim, section }]`, where `section` is a heading in `methodology.md`.

An empty array on a substantive report is a red flag: flag it in `runs/…` and surface it on the report. It means the model ignored the method, not that a tool failed.

### 3.3 Cache

DeepSeek disk-caches prefixes automatically. Hits require a full match of a persisted prefix unit, not a fuzzy overlap. Keep the system message byte-stable. Put the date, asset, and actual timeframes in the user message, last. Log `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens`. Cache is best-effort; do not depend on it for correctness.

The 07:00 UTC cron sits inside DeepSeek peak hours (06:00–10:00 UTC, weekdays). At two requests a day this does not matter. Do not move the cron to chase the off-peak rate.

---

## 4. Capture stage

### 4.1 Timeframe set — still open

Shipped cron (`index.js`) captures `1D`, `30m`, `3h` per asset: six PNGs, six browser sessions. `TIMEFRAME_LABELS` has `30m`, `3h`, `1D`, `1W`, `1M`, `3M`, `1Y`. There is no `15m` label. A failed interval toggle is logged and the screenshot is still saved.

| Option | Timeframes per asset | Supports | Risk |
|---|---|---|---|
| **A — Intraday** | `1D`, `3h` (or `30m`), `15m` | Structure + timing | `15m` unverified in the widget |
| **B — Positional** | `1Y`, `3M`, `1D` | Long-horizon context | Labels already work; daily reports will repeat |
| **C — Both** | 5 images | Richer read | 10 images/day, harder prompt |

**Recommendation: A**, matching the current cron's intent, with `15m` only after the widget label is confirmed. If `3 hours` is absent, fall back to `30 minutes` and record which was used. Current `{1D, 30m, 3h}` is an acceptable stand-in until that check lands.

Either way: **exactly three images per asset per run**. The report states timeframes *actually* captured, never those requested. Three images is far under the API limits (600 images, 8192 px per side, 32 MiB per inline image, 48 MiB body).

### 4.2 Required hardening

Unchanged from v3, and still missing in the code:

1. **Chart-visibility assertion.** Bounding box exceeds ~600×300 before screenshot. A blank PNG is a valid file, and the model will describe it.
2. **Interval-change verification.** Read the widget interval label back, or hash consecutive screenshots. A silent toggle failure must not store three identical images.
3. **Clip to the chart element.** Target ~1200×700. Full-page shots waste the ~1024 token/image cap on nav and ads. DeepSeek rescales large images toward ~1300×1300 before inference; clipping is what keeps candle detail inside that budget.

One browser session per asset across all three timeframes. Keep the free-tier limit guard and `/cleanup`.

---

## 5. Storage

Stay on **KV**.

```
{asset}/{tf}/{date}.png          ← exists
{asset}/{tf}/latest.png          ← exists
reports/{asset}/{date}.json      ← validated analysis + metadata
reports/{asset}/{date}.md        ← rendered report
runs/{asset}/{date}.json         ← timings, usage, cache hit/miss, reasoning_content, errors
```

Date in the key is the UTC date of the cron instant (`YYYY-MM-DD`). 07:00 UTC is 09:00 SAST, same calendar day.

Idempotency: if `reports/{asset}/{date}.json` exists and `force=1` was not passed, skip analysis. Screenshots overwrite on a forced re-run. A manual trigger is what passes `force=1`; the cron cannot.

Re-analysis does not need a provider file id. Read the PNG bytes from KV and base64-encode them again. Do not persist a DeepSeek `file_id`.

---

## 5a. TypeScript

Convert `index.js` to TypeScript before the analysis work (CS-0). Pure port, no behaviour changes.

```
src/
  index.ts                 fetch handler: routes only
  workflow.ts              DailyAnalysisWorkflow (CS-F)
  capture/browser.ts       session, consent, interval switching, screenshots
  capture/config.ts        asset + timeframe config
  analysis/client.ts       per-request Chat Completions client
  analysis/analyse.ts      base64 images + chat completion + Zod parse
  analysis/prompt.ts       system prompt + PROMPT_VERSION
  analysis/schema.ts       Zod schema (single source of truth)
  report/render.ts         ChartAnalysis → Markdown (pure)
  storage/kv.ts            key builders + get/put/list helpers
knowledge/methodology.md   committed decision procedure
```

No `scripts/setup-vector-store.ts`.

- `wrangler types` → committed `worker-configuration.d.ts`.
- `strict: true`. `npx tsc --noEmit` before deploy.
- `ChartAnalysis` is `z.infer` of the schema in `analysis/schema.ts`. No parallel interface.

---

## 6. Analysis call

### 6.1 Client and config

`POST https://api.deepseek.com/chat/completions`.

| Setting | Value |
|---|---|
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `DEEPSEEK_REASONING_EFFORT` | `high` (`low` / `high` / `max`; `medium` is mapped to `high` by the API) |
| `DEEPSEEK_API_KEY` | `wrangler secret put` |
| Thinking | enabled (API default). Pass `thinking: { type: "enabled" }` explicitly |
| `max_tokens` | `16384` to start. Thinking shares this budget with the JSON |

Workers notes:

- **No `fs`.** The screenshot is a `Uint8Array` from Puppeteer or KV. Encode with `Buffer.from(bytes).toString("base64")` (`nodejs_compat` is already on). Do not add a filesystem shim.
- **Build the client per request** from `env.DEEPSEEK_API_KEY`. There is no `process.env` at module scope.
- **`temperature` is ignored** while thinking is on. Do not set it.

`ai` + `@ai-sdk/openai` with `createOpenAI({ baseURL, apiKey })` and `.chat(model)` is acceptable only if the bytes on the wire are Chat Completions: `image_url` data URLs, `response_format: { type: "json_object" }`, and `POST /chat/completions`. DeepSeek's documented base URL is `https://api.deepseek.com` (the OpenAI SDK appends `/chat/completions`). If the SDK posts to `/responses` or sends `json_schema`, stop and `fetch` `/chat/completions` directly. Do not use `Output.object()` or `generateObject` as the wire format — those emit a schema DeepSeek does not enforce.

Check bundle size if the SDK is added (`wrangler deploy --dry-run --outdir dist`). A raw `fetch` is the smaller option and is enough for one endpoint.

### 6.2 Request

```ts
{
  model: env.DEEPSEEK_MODEL,
  messages: [
    {
      role: "system",
      content: systemPrompt, // methodology + contract + the word "json" + an example. Text only.
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Image 1 of 3 — 1 day" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png1}`, detail: "original" } },
        { type: "text", text: "Image 2 of 3 — 3 hours" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png2}`, detail: "original" } },
        { type: "text", text: "Image 3 of 3 — 15 minutes" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png3}`, detail: "original" } },
        { type: "text", text: runContext }, // asset, UTC date, actual timeframes — LAST
      ],
    },
  ],
  response_format: { type: "json_object" },
  reasoning_effort: env.DEEPSEEK_REASONING_EFFORT,
  max_tokens: 16384,
  thinking: { type: "enabled" },
}
```

Label every image with a preceding text part. The labels must name the timeframes actually captured. MIME in the data URL is advisory; DeepSeek detects format from the bytes. PNG, JPEG, GIF, and WebP are accepted.

Do not send tools. This is a single turn, so `reasoning_content` is not passed back. Log it on the run record; do not put it in the report.

### 6.3 Structured output

DeepSeek JSON mode guarantees a JSON *string*, not a schema. The API can also return empty `content`. Requirements from their guide, all mandatory:

1. `response_format: { type: "json_object" }`.
2. The system prompt contains the word `json` and an example object.
3. `max_tokens` high enough that thinking plus the object is not cut off.
4. Treat empty `content` as a failure, not as a successful empty report.

The example in the prompt is generated from the Zod schema (a fixture that `schema.parse` accepts). Do not hand-maintain a second shape.

After the call:

1. If `content` is empty, or `finish_reason` is `"length"`, retry once. A length finish means the JSON was truncated; do not parse it.
2. `JSON.parse`, then `schema.parse`.
3. On `ZodError` or `SyntaxError`, retry once with the same images and the validation error appended to the user text.
4. Second failure: write `content`, `reasoning_content`, `finish_reason`, and `usage` to `runs/{asset}/{date}.json`. Do not write `reports/…`.

### 6.4 Schema

One Zod schema in `src/analysis/schema.ts`. It validates the parsed object and types `render.ts`. It is not sent as `json_schema`.

Fields: `schema_version`, `prompt_version`, `model`, `generated_at_utc`, `asset`, `capture{requested_timeframes, actual_timeframes, capture_quality, notes}`, `bias{direction, timeframe_agreement, rationale}`, `timeframes[]`, `confluence[]`, `conflicts[]`, `invalidation[]`, `method_citations[{claim, section}]`, `confidence`, `caveats[]`.

Use `.nullable()` over `.optional()`. `capture_quality` is `"ok"` or `"poor"`.

`direction` is `"up" | "down" | "mixed" | "unclear"`. No buy/sell enum.

---

## 7. Prompt contract

`src/analysis/prompt.ts` assembles the system message from `knowledge/methodology.md` plus the output rules. `PROMPT_VERSION` is stored on every report.

- Apply the methodology in the system prompt. Cite the section heading for each judgement (`method_citations`). If the methodology does not cover something, say so. Do not invent a method.
- Read top-down: longest timeframe for context, shortest for timing. State where the timeframes disagree.
- Describe only what is visible. No invented indicator values. Levels read off an axis are approximate.
- If an image is blank, obscured, or the wrong timeframe, set `capture_quality: "poor"` and explain. That is a successful analysis of a bad capture, not a failed run.
- No buy/sell recommendations. Structure, levels, and invalidation only.
- Output one JSON object matching the example. No markdown fence.

---

## 8. Reporting surface

- `GET /reports?token=…` — list dates, newest first.
- `GET /reports/:asset/:date?token=…` — Markdown rendered to HTML.
- `GET /reports/:asset/:date/:tf.png?token=…` — generalise the existing `/latest` handler.
- All `/reports` routes gated on `VIEWER_TOKEN` (Worker secret). Wrong or missing token → 404, not 401.
- `render.ts` is a pure `(ChartAnalysis) => string`. No network. Re-runnable over stored JSON.
- `capture_quality: "poor"` renders a warning at the top and suppresses the bias line.
- Empty `method_citations` on a report that is not `poor` renders a grounding warning.
- Footer on every report: automatically generated commentary from a model reading images and a written method; not investment advice; not verified against price data.

---

## 9. Open decisions

1. **Timeframe set** — A / B / C (§4.1). Current cron is `{1D, 30m, 3h}`. Blocks capture hardening only in the sense of which labels to verify. `15m` is not in the code.
2. **The methodology text** — contents of `knowledge/methodology.md`. Human-only. Blocks a meaningful CS-E, not the client wiring.
3. **Both assets or one to start** — `gold` only during analysis bring-up.

Model is not an open decision. `deepseek-flash` only.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Blank or overlay chart described with confidence | Visibility assertion (§4.2); `poor` path tested with a deliberately bad image |
| Three identical images from a silent toggle | Interval-change verification (§4.2); current code saves the screenshot anyway |
| `detail: "low"` or an unclipped page shot destroys wick/axis detail | `detail: "original"`; clip to ~1200×700 |
| Image placed in the system message | 400 from the API. Methodology is text; images are user content parts |
| JSON mode returns empty `content` or truncated JSON | Retry once; never persist a parse failure; log `finish_reason` |
| `json_schema` / `Output.object()` used by mistake | Wire format is `json_object` plus a local Zod parse (§6.1, §6.3) |
| Model ignores the methodology | `method_citations` required; empty array flagged in the run log and on the report |
| Thinking budget eats `max_tokens` and cuts the JSON | Start at 16384; `finish_reason: "length"` is a failed run |
| Retired vision alias configured | `DEEPSEEK_MODEL=deepseek-flash` only |
| Pro chosen as an "escalation" | Pro has no vision. Escalate effort to `max`, not model |
| Provider built at module scope | Construct the client per request from `env.DEEPSEEK_API_KEY` |
| Free-tier browser minutes burned on prompt iteration | Re-encode PNGs from KV. No recapture, no Files API |
| Prompt drift | `PROMPT_VERSION` + `schema_version` on every report |
| Report read as trading advice | No buy/sell language; disclaimer footer; `confidence` and `caveats` |
