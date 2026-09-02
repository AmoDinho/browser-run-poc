# Spec v3: Daily Chart Analyst — OpenAI analysis stage

**Supersedes:** v1 (OpenAI, but written against a GBP/USD design that no longer matches the code) and v2 (DeepSeek).
**Reconciled against:** the shipped `browser-run-hello-world` Worker on `feature/real_stuff`, and `docs/fx_daily_chart_spec.md`.
**Status:** capture stage ~70% done; analysis and reporting stages not started.

---

## 1. What this version settles

| Decision | Choice |
|---|---|
| Language | **TypeScript**, whole project |
| Analysis client | **AI SDK 7** (`ai` + `@ai-sdk/openai`), Responses API models |
| Model | `gpt-5.6-luna` (§6.1a) |
| Grounding | **Hosted `file_search`** over a vector store of the textbook PDFs |
| Assets | `nasdaq100`, `gold` — as shipped, not v1's GBP/USD |
| Storage | **KV** (`CHARTS_KV`) — as shipped, not v1's R2 |
| Cron | `0 7 * * 1-5` UTC — as shipped |
| Structured output | Zod schema via `Output.object()` — see §6.5 for the tool-interaction caveat |

Reverting to OpenAI removes the one hard blocker in v2: DeepSeek's Files API accepts images only and has no retrieval tool, which forced textbook PDFs to be distilled into a hand-curated knowledge pack. OpenAI's `file_search` takes the PDFs natively, parses images inside them (charts, pattern plates), and returns citations back to the source files. The original "the model looks at its own files" design works as intended.

**Reversal on my earlier advice:** v1 and v2 both said skip the SDK and hand-roll `fetch`, on the grounds that it's bundle weight for one endpoint. That was right when the design was one raw POST with hand-written JSON schema and hand-written validation. It's wrong now. The AI SDK collapses three pieces of this spec into library features: `uploadFile` replaces the multipart Files API plumbing, `Output.object()` with a Zod schema replaces the hand-written `json_schema` plus separate Zod validation pass (one schema, one source of truth, typed result), and the provider abstraction replaces the custom `provider.ts` seam I specified in §1 item 3 — which is now deleted, since swapping provider is a two-line change by design.

Two things from the v2 exercise still carry over:

1. **Prompt ordering for cache hits** (§6.2). OpenAI caches long stable prefixes automatically. Variable content goes last.
2. **File reference reuse for screenshots** (§6.3). Turns prompt iteration from a 60-second loop that eats browser minutes into a 5-second one.

---

## 2. Target state

```
cron 0 7 * * 1-5 (UTC)
   │
   ├─ for each asset [nasdaq100, gold]:
   │     one browser session ──▶ 3 screenshots (§4.1) ──▶ KV
   │
   ├─ uploadFile (AI SDK) ──▶ ProviderReference per screenshot
   │
   ├─ generateText  (ai + @ai-sdk/openai, openai.responses)
   │     system: stable prompt · messages: labelled images + run context (last)
   │     tools: { file_search: fileSearch({ vectorStoreIds }) }
   │     output: Output.object({ zodSchema })
   │        │
   │        ▼
   │     typed ChartAnalysis ──▶ retry once on NoObjectGeneratedError
   │
   └─ render Markdown ──▶ KV ──▶ served at /reports
```

---

## 3. Grounding

### 3.1 Vector store setup — one-time, out of band

`scripts/setup-vector-store.mjs`, run locally by you, **never by the Worker**:

1. `POST /v1/files` for each PDF in `knowledge/src/`.
2. `POST /v1/vector_stores` → capture the `vs_…` id.
3. Attach files; poll until every file reports `completed`.
4. Print the id for pasting into `wrangler.jsonc` as `OPENAI_VECTOR_STORE_ID`.

Idempotent: if a store with the configured name exists, add only files whose names aren't already present. Uploading the textbooks on every scheduled run would be slow, costly and pointless.

Keep the PDFs gitignored. Commit `knowledge/manifest.json` recording filenames, page counts and the store id, so the grounding corpus behind any given report is traceable.

### 3.2 Making retrieval verifiable

`file_search` decides for itself whether to search, which means a report can silently be ungrounded. Two guards:

- The prompt requires citations: `doc_citations: [{ claim, source_file, locator }]`. An empty array on a substantive report is a red flag worth surfacing in the run log.
- The response includes the `file_search_call` item. **Log whether a search actually happened**, and its query. If the model stops searching, you want to know from the logs, not from a slow drift in output quality.

### 3.3 Optional: a methodology summary in the system prompt

If the textbooks are long or discursive, a short (500–1500 token) summary of the method's *structure* in the system prompt — section headings, decision order, what to check first — makes retrieval more targeted without replacing it. Worth doing if early output feels unanchored. Not required to start.

---

## 4. Capture stage (reconciled with what's built)

### 4.1 Timeframe set — decision required, blocks CS-A/B

v1 asked for Daily / 3-hour / 15-minute. The shipped code implements 1D / 1W / 1M / 3M / 1Y and the cron captures **1D only**.

| Option | Timeframes per asset | Supports | Risk |
|---|---|---|---|
| **A — Intraday** | `1D`, `3H` (or `30M`), `15M` | Structure + timing | Intraday labels unverified in the widget |
| **B — Positional** | `1Y`, `3M`, `1D` | Long-horizon context | None — labels already work |
| **C — Both** | 5 images | Richer read | 10 images/day, harder prompt |

**Recommendation: A.** A 07:00 UTC weekday cadence with a 15-minute chart is an intraday-decision shape; B's 1Y/3M charts barely move day to day, so a daily report on them will read as repetitive. But B works today at zero discovery risk. Confirm the intraday labels exist before committing — `"15 minutes"`, `"3 hours"`, `"30 minutes"` follow the existing `"1 day"` / `"1 week"` convention but are unverified. If 3-hour is absent, fall back to 30-minute and record which was used.

Either way: **exactly three images per asset per run**, and the report states which timeframes were *actually* captured, never which were requested.

### 4.2 Required hardening

The existing `captureScreenshot()` is sound, but three gaps matter far more once a model consumes the output instead of a human:

1. **Chart-visibility assertion.** Assert the chart element's bounding box exceeds ~600×300 before screenshotting. A blank or overlay-covered chart currently produces a valid PNG, and the model will describe it with complete confidence. Highest-value defensive change in the codebase.
2. **Interval-change verification.** Confirm the interval actually changed — read the widget's interval label, or compare a perceptual hash of consecutive screenshots. A silent toggle failure yields three identical images described as three timeframes.
3. **Clip to the chart element.** Full-page shots feed nav, ads and footer into the model's context and inflate image tokens. Target ~1200×700.

One browser session per asset across all three timeframes. Keep the existing free-tier limit guard and `/cleanup` endpoint — both are doing real work.

---

## 5. Storage

Stay on **KV**. It works, it's wired, and migrating to R2 buys nothing at one run a day. Revisit only for lifecycle expiry rules or if the archive grows large.

Extend the existing scheme:

```
{asset}/{tf}/{date}.png          ← exists
{asset}/{tf}/latest.png          ← exists
reports/{asset}/{date}.json      ← new: validated analysis + metadata
reports/{asset}/{date}.md        ← new: rendered report
runs/{asset}/{date}.json         ← new: timings, token usage, file_search calls, errors
```

Idempotency: if `reports/{asset}/{date}.json` exists and `force=1` wasn't passed, skip. Screenshots overwrite on forced re-runs.

Store each screenshot's `ProviderReference` in the report JSON so re-analysis under a new prompt version needs no browser run.

---

## 5a. TypeScript

The shipped Worker is a single `index.js`. Convert the project to TypeScript as the first change set (CS-0), before the analysis work lands — retrofitting types onto a codebase that already has an SDK integration in it is strictly more work than doing it first.

```
src/
  index.ts                 fetch handler: routes only
  workflow.ts              DailyAnalysisWorkflow (CS-F)
  capture/browser.ts       session, consent, interval switching, screenshots
  capture/config.ts        asset + timeframe config
  analysis/client.ts       AI SDK provider construction
  analysis/analyse.ts      upload + generateText + Output.object
  analysis/prompt.ts       system prompt + PROMPT_VERSION
  analysis/schema.ts       Zod schema (single source of truth)
  report/render.ts         ChartAnalysis → Markdown (pure)
  storage/kv.ts            key builders + get/put/list helpers
scripts/setup-vector-store.ts
docs/CAPTURE-NOTES.md
```

- `wrangler types` generates the `Env` interface from `wrangler.jsonc` bindings — commit `worker-configuration.d.ts` and regenerate whenever a binding changes.
- `strict: true` in `tsconfig.json`. The point of this migration is catching a `capture_quality` typo at build time, and non-strict mode gives most of that away.
- `npx tsc --noEmit` in CI, or at minimum as a pre-deploy npm script.
- Types flow from one place: the Zod schema in `analysis/schema.ts` infers `ChartAnalysis`, which types the SDK call, the KV writes, and `render.ts`'s parameter. Don't hand-write a parallel interface.

The conversion itself is mostly mechanical — `index.js` is one file — so keep it a pure port with no behaviour changes, and land the capture hardening (CS-A) as a separate commit on top. Mixing a language migration with logic changes makes both impossible to review.

---

## 6. Analysis call

### 6.1 Client and config

**AI SDK 7** (`ai` + `@ai-sdk/openai`), using `openai.responses(...)` — the Responses API model factory, which is what `file_search` requires. Not `openai.chat(...)`.

```
npm i ai @ai-sdk/openai zod
```

| Setting | Value |
|---|---|
| `OPENAI_MODEL` | `gpt-5.6-luna` |
| `OPENAI_REASONING_EFFORT` | `medium` to start (Luna supports `none`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `OPENAI_API_KEY` | `wrangler secret put` |
| `OPENAI_VECTOR_STORE_ID` | from §3.1 |

Two Workers-specific notes the AI SDK docs won't give you, because their examples assume Node:

- **No `fs`.** Every SDK example reads bytes with `fs.readFileSync`. In the Worker the screenshot is already a `Uint8Array` from Puppeteer or KV — pass it straight to `uploadFile`'s `data`. Don't add a Node filesystem shim to satisfy a copied example.
- **Instantiate the provider per request**, with `createOpenAI({ apiKey: env.OPENAI_API_KEY })`. Workers have no `process.env` at module scope, so the default `openai` singleton that reads `OPENAI_API_KEY` from the environment won't resolve. This is the single most common way this integration fails on first run.

Check bundle size after adding the SDK (`wrangler deploy --dry-run --outdir dist`). Free-plan Workers cap at 3 MB compressed; this should fit comfortably, but know the number.

### 6.1a Model tier — Luna, with one calibration step

`gpt-5.6-luna` is the cost-efficient tier of the GPT-5.6 family (Sol → Terra → Luna), roughly corresponding to the nano tier in earlier GPT-5 generations. It supports everything this pipeline needs: vision, prompt caching, structured output, function calling, a ~1.05M context window, and reasoning effort up to `max`. Listed at $0.20/M input and $1.20/M output after the 30 July price cut.

Two things worth knowing before locking it in:

**The cost argument barely applies at this volume.** Luna exists for high-volume, latency-sensitive workloads. This pipeline makes **two requests per day** — one per asset — with six images total. The Sol/Luna price gap is around 25×, but on absolute spend that's the difference between pennies and slightly fewer pennies per month. Whatever tier reads charts best is effectively free here.

**Chart reading is where the cheapest tier is most likely to break.** Multi-image fine-detail visual reasoning — candle bodies, wick extremes, axis values, level alignment across three timeframes — plus retrieval grounding plus a strict schema is close to the hardest combination you can hand a vision model. A misread here doesn't fail loudly; it produces a fluent, confident, wrong report.

**So: build on Luna as specified, but add a one-off calibration step to CS-E.** Take one day's six screenshots and run them through `gpt-5.6-luna` and `gpt-5.6-terra` at the same reasoning effort. Compare the reads against your own reading of the same charts. Keep Luna if it holds up; escalate a tier if it doesn't. Costs a few cents and settles the question with evidence instead of opinion. Swapping the model is a one-line change to the string passed to `openai.responses(...)`.

If Luna is borderline, try raising `reasoning_effort` to `high` before escalating tiers — on this workload that's likely the cheaper lever.

### 6.1b Optional: routing via Cloudflare instead of OpenAI directly

`openai/gpt-5.6-luna` is available through Workers AI. Tempting given the rest of the stack lives on Cloudflare, and it would remove one secret from the Worker.

**Verify before relying on it:** hosted tools like `file_search` depend on OpenAI platform-side vector stores, and it's not established that the Cloudflare-proxied Responses endpoint passes them through. If it doesn't, routing via Workers AI silently costs you the entire grounding mechanism. Point the SDK at OpenAI directly for v3. If you want gateway observability, `createOpenAI({ baseURL: <AI Gateway URL> })` in front of a direct OpenAI call gets it without that risk.

### 6.2 Upload

```ts
const { providerReference } = await uploadFile({
  api: openaiProvider.files(),
  data: screenshotBytes,               // Uint8Array from Puppeteer/KV, not fs
  filename: `${asset}-${date}-${tf}.png`,
  providerOptions: { openai: { purpose: 'vision' } },   // OpenAI requires a purpose
});
```

`uploadFile` returns a `ProviderReference` — a `Record<string, string>` like `{ openai: 'file-abc123' }`, not a bare id string. Persist the whole object in the report JSON, not just the inner value, so re-analysis under a new prompt version needs no browser run.

**Verify the image content-part shape at implementation time.** The AI SDK 7 docs show two forms for passing a reference as an image, and they don't agree with each other:

```ts
{ type: 'file',  mediaType: 'image', data: providerReference }   // AI SDK 7 announcement
{ type: 'image', image: providerReference }                       // file-uploads doc page
```

Try the `file`/`mediaType` form first and fall back to the other. Don't spend an afternoon debugging a request shape when the docs are ambiguous — one round trip settles it.

### 6.3 Request ordering

```ts
generateText({
  model: openaiProvider.responses(env.OPENAI_MODEL),
  system: SYSTEM_PROMPT,                      // 100% stable — enables prefix caching
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'Image 1 of 3 — Daily' },     { /* image */ },
    { type: 'text', text: 'Image 2 of 3 — 3-hour' },    { /* image */ },
    { type: 'text', text: 'Image 3 of 3 — 15-minute' }, { /* image */ },
    { type: 'text', text: runContext },       // asset, date, UTC time, actual TFs — LAST
  ]}],
  tools: { file_search: openaiProvider.tools.fileSearch({
    vectorStoreIds: [env.OPENAI_VECTOR_STORE_ID],
    maxNumResults: 8,
  })},
  providerOptions: { openai: {
    reasoningEffort: env.OPENAI_REASONING_EFFORT,
    include: ['file_search_call.results'],    // makes grounding auditable
  }},
  stopWhen: stepCountIs(4),                   // see §6.5
})
```

The tool **must** be keyed `file_search` — OpenAI's API requires that exact name and the SDK won't rename it for you.

Label every image with a preceding text part. Without labels the model cannot tell which screenshot is which timeframe, and it will guess — usually plausibly and wrongly. Keep the date out of `system`; it's one token of information and it breaks prefix caching daily.

If the model proves reluctant to search, `toolChoice: { type: 'tool', toolName: 'file_search' }` forces it. Prefer logging first and forcing only if the logs show it skipping — a forced search on every call is a blunter instrument than it looks.

### 6.4 Reading the grounding trail

`include: ['file_search_call.results']` plus the SDK's `steps`/`sources` output gives you what actually got retrieved. Log per run: whether a `file_search` call happened, its query, and how many results came back. This is the only way to notice the model quietly stopping searching, which otherwise shows up as a slow unexplained decline in report quality.

Known SDK friction worth knowing about up front: there have been reported type-validation failures on OpenAI `file_citation` annotations missing `start_index`/`end_index` fields. If you hit an `AI_TypeValidationError` inside the response parse, it's that class of bug, not your code. Pin the SDK version and check the changelog before upgrading.

### 6.5 Structured output — the one real landmine

Use `generateText` with `output: Output.object({ schema })` and a Zod schema. **Not `generateObject`** — `generateObject` and `streamObject` don't support tool calling at all, so using them would silently discard `file_search` and hand you an ungrounded report that looks perfectly fine.

Three things that follow from that:

1. **Structured output counts as an extra step** in the SDK's multi-step model. With one `file_search` call plus the shaping step, `stopWhen: stepCountIs(4)` is a sane starting budget. Too low and you get `NoObjectGeneratedError` on a run that was working fine.
2. **Handle `NoObjectGeneratedError` explicitly.** It exposes `cause`, `text`, `response` and `usage` — write all four to `runs/…` on failure. Without them a failed run tells you nothing.
3. **Tools + structured output is historically the flakiest combination in this SDK.** There are documented cases of providers warning `JSON response format does not support tools` and silently ignoring the tools. That failure mode is *exactly* our disaster case: a well-formed report with no grounding behind it.

**So verify it explicitly in CS-E**, before building anything on top: confirm in the logged steps that a `file_search` call happened *and* a schema-valid object came back **in the same request**. If it doesn't hold on Luna, fall back to a two-call design:

- **Call 1** — `generateText` with `file_search`, no structured output. Produces prose analysis plus citations.
- **Call 2** — `generateObject` with the Zod schema over that prose. No tools, no images, pure shaping.

Two Luna calls cost fractions of a cent, the shaping call is near-deterministic, and it removes the interaction risk entirely. Treat this as the expected outcome rather than a defeat — if CS-E's single-call check is at all marginal, take the two-call path and move on.

### 6.6 Schema

One Zod schema in `src/analysis/schema.ts` is the single source of truth: it drives `Output.object()`, types the analysis object, and types `render.ts`'s input. No separate hand-written JSON schema, no second validation pass.

Fields: `schema_version`, `prompt_version`, `model`, `generated_at_utc`, `asset`, `capture{requested_timeframes, actual_timeframes, capture_quality, notes}`, `bias{direction, timeframe_agreement, rationale}`, `timeframes[]`, `confluence[]`, `conflicts[]`, `invalidation[]`, `doc_citations[]`, `confidence`, `caveats[]`.

Use `.nullable()` over `.optional()` throughout. Providers handle strict-mode required-field semantics inconsistently, and an explicit null is easier to render than a missing key.

---

## 7. Prompt contract

`src/analysis/prompt.ts`, with `PROMPT_VERSION` recorded in every report so output changes trace to their cause.

- Apply the methodology in the attached reference documents; search them before concluding; cite which document informed each judgement. If they don't cover something, say so rather than improvising.
- Read top-down: longest timeframe for context, shortest for timing. **State explicitly where the timeframes disagree** — that's the most useful line in the report.
- Describe only what is visible. No invented indicator values. Levels read off an axis are marked approximate.
- If an image is blank, obscured, or shows an unexpected timeframe, set `capture_quality: "poor"` and explain. First-class outcome, not something to paper over.
- No buy/sell recommendations. Structure, levels, and invalidation conditions only.

---

## 8. Reporting surface

- `GET /reports?token=…` — list dates, newest first.
- `GET /reports/:asset/:date?token=…` — Markdown rendered to HTML.
- `GET /reports/:asset/:date/:tf.png?token=…` — generalise the existing `/latest` handler.
- All routes gated on `VIEWER_TOKEN`; wrong or missing → 404, not 401.
- `render.ts` is a pure `(ChartAnalysis) => string`: no network, unit-testable, re-runnable over stored JSON when the template changes.
- `capture_quality: "poor"` puts a warning block at the top and **suppresses the bias line**. A degraded capture must not read like a clean signal.
- Footer on every report: automatically generated descriptive commentary from a model reading an image; not investment advice; not verified against price data.

---

## 9. Open decisions

1. **Timeframe set** — A / B / C (§4.1). Blocks capture work.
2. **The textbooks** — which ones. `file_search` removes the curation burden, but not the judgement one: if the method is vague, "apply the attached methodology" means nothing concrete. Longest-lead item and the only one no agent can do for you.
3. **Both assets or one to start** — recommend `gold` only during analysis bring-up. Halves the debugging surface and the image spend.
4. **Model tier** — `gpt-5.6-luna` chosen. Settled by the CS-E calibration run (§6.1a), not by argument: if Luna's chart read is materially worse than Terra's on the same six screenshots, escalate. Cost is not a meaningful input at two requests a day.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Blank/overlay chart → confident fiction | Visibility assertion (§4.2); `poor` path tested with a deliberately bad image |
| Three identical images from a silent toggle failure | Interval-change verification (§4.2) |
| Luna misreads chart detail (wicks, axis values, level alignment) | CS-E calibration against Terra; raise `reasoning_effort` before escalating tier; `OPENAI_MODEL` as a var |
| Model silently stops using `file_search` | Log `file_search_call` presence and query every run |
| Routing via Workers AI drops `file_search` support | Point the SDK at OpenAI directly in v3; verify proxy tool support before switching (§6.1b) |
| **`generateObject` used by mistake → tools silently dropped → ungrounded report that looks fine** | §6.5: `generateText` + `Output.object` only; CS-E explicitly asserts a `file_search` call and a valid object in the same request |
| Tools + structured output flaky on this model/SDK combination | Two-call fallback in §6.5, pre-specified so it isn't an emergency redesign |
| SDK `file_citation` type-validation bug on annotations | Pin the SDK version; check changelog before upgrading |
| Provider built at module scope fails in Workers (no `process.env`) | `createOpenAI({ apiKey: env.… })` per request (§6.1) |
| Empty `doc_citations` passing unnoticed | Flag in run log; surface in the report |
| Free-tier browser minutes exhausted during iteration | `file_id` reuse enables prompt iteration without recapture |
| Prompt drift as output is tuned | `PROMPT_VERSION` + `schema_version` in every report |
| Report read as trading advice | No buy/sell language in prompt; disclaimer footer; `confidence` and `caveats` at top |
