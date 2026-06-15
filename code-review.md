# Code Review — sparsi-ts

A catalog of internal inconsistencies, non-idiomatic code, likely bugs, and
cleanup opportunities found by reading every file under `src/` and `examples/`.
Each item lists the location(s), what's wrong, and a suggested fix. Items are
grouped by severity. Nothing here has been changed yet — this is the to-do list
for making the library functional, clean, and idiomatic TypeScript.

---

## 1. Bugs / correctness

### 1.1 MCP retry warning is off-by-one (inconsistent with the sibling op)
- `src/mcp/call.ts:223` — `attempt ${attempt + 1} of ${cfg.maxRetries}`
- `src/mcp/script.ts:141` — `attempt ${attempt + 1} of ${cfg.maxRetries + 1}`

Both loops run `for (attempt = 0; attempt <= cfg.maxRetries; attempt++)`, i.e.
`maxRetries + 1` total attempts. `script.ts` prints the total correctly;
`call.ts` prints `maxRetries`, so with the default `maxRetries: 3` it logs
"attempt 4 of 3". Fix `call.ts` to `${cfg.maxRetries + 1}` to match.

### 1.2 `MCPCallOp` documents an output kind that doesn't exist (`"bool"`)
- `src/mcp/call.ts:42-44` (description) vs `src/ai/compute.ts:28-34` (`OutputKind`)

The catalog description advertises `output` values `"string"`, `"number"`,
**`"bool"`**, `"string[]"`, `"number[]"`, `"json"`. The real `OutputKind` uses
`"boolean"`, not `"bool"` (see `coerceStructured`/`parseResult` switch cases). A
user copying the doc and passing `output: "bool"` fails the type check and, at
runtime, `parseResult` hits its `default` branch and throws
`unsupported output type: bool`. Also, the valid kind `"map"` is missing from the
documented list. Fix the description to `"boolean"` and add `"map"`.

### 1.3 Suspicious / likely-invalid Gemini model id in three examples
- `examples/recipe-analyzer.ts:24`, `examples/stock-analyzer.ts:16`,
  `examples/faithful-summary.ts:28` — `"gemini-3.1-flash-lite"`

This id is inconsistent with the client default `"gemini-2.5-flash"`
(`src/ai/client.ts:73`) and the embedding default `"gemini-embedding-001"`.
`gemini-3.1-flash-lite` does not appear to be a real published model id; these
examples will fail at the provider with a 404/model-not-found. Verify against the
current model list and pin to a real id (e.g. `gemini-2.5-flash`).

### 1.4 `RunResult.skipped()` disagrees with `get()`/`getOr()` on "not run"
- `src/engine.ts:331-333` vs `:319-330`

`get`/`getOr` treat a node missing from `resultMap` (`r === undefined`) as
skipped; `skipped()` returns `isSkip(resultMap.get(node.id))`, which is `false`
for `undefined`. In the current control flow every node is always present, so
this is latent, but the asymmetry is a trap for future changes (and for anyone
passing a `Node` from a *different* workflow). Make `skipped()` return
`r === undefined || isSkip(r)` to match the other two accessors.

### 1.5 `aiScore` silently scores 0 on a missing field (reasoning mode only)
- `src/ai/ops.ts:172-176`

In reasoning mode a missing/`null` `score` field defaults to `0` (a valid
in-range value) and returns successfully, while the non-reasoning branch
(`:182-189`) treats an empty/non-numeric answer as a retry. So the same model
omission yields a confident `0.0` in one mode and a retry in the other. If `0`
defaulting is intentional, document it on `AIScoreOpDescription`; otherwise treat
a missing score as a retry in both branches for consistency.

---

## 2. Documentation that no longer matches the code

### 2.1 Misplaced JSDoc block in `compute.ts`
- `src/ai/compute.ts:141-162`

Two doc-comment blocks are stacked immediately above `goQuote`: the first
(`141-146`, "Renders an op input for prompt interpolation…") actually documents
`describeInput`, but `goQuote` and its *own* doc comment (`147-153`) were inserted
between the comment and `describeInput` (`155`). Result: `goQuote` carries two
doc comments and `describeInput` is left undocumented. Move the `describeInput`
comment back down onto `describeInput`.

### 2.2 `WithRepairDescription` still references the removed `parse` callback
- `src/ai/repair.ts:22-28`

S3 replaced `WithRepairConfig.parse` with `codec`, but the catalog description
still says it "parses the response into a fresh input value via the configured
**parse callback**" (line 26). The very next bullet correctly says "RepairCodec".
Update line 26 to refer to the codec.

### 2.3 AI op descriptions claim an object output the ops don't return
- `src/ai/descriptions.ts:23,30,37,44,51,58,65,72,79,85,91`

Every `Output:` line is documented as `{ result: …, reasoning: string }`, but the
ops (and the `wf.ai.*` nodes) return the bare value (`string`, `number`, …); the
reasoning is delivered out-of-band via `RunResult.reasoning`, not in the returned
value. The descriptions overstate the return shape. State the actual return type
and note reasoning is captured separately.

### 2.4 Go-flavored identifiers and type names leak through a TS surface
- `src/ai/descriptions.ts:25` — `AIComputeMathOperandsToFloat64OpDescription` /
  `…ToFloat64Op` naming
- `src/ops/*` descriptions — `*int`, `*[]float64`, `Result int`, `*number` with a
  Go-style `*` "required" marker (`src/ops/slice.ts:33-48`,
  `src/ops/json.ts:34`, etc.)
- `src/ops/json.ts:43-49` — `goTypeName()` returns `"float64"`, `"<nil>"`,
  `"bool"` in user-facing error messages
- `src/ai/compute.ts:153` — `goQuote`

These are TS modules describing a single IEEE-754 `number` type, but the docs and
error strings surface Go types (`int`, `float64`, `<nil>`, `bool`) and Go naming
(`goQuote`, `goTypeName`, `Float64Op`). For an idiomatic TS library, rename
`goQuote`→`quote`, `goTypeName`→`jsonTypeName` (returning `"number"`/`"null"`/
`"boolean"`), and normalize the description type vocabulary to TS (`number`,
`string[]`, `boolean`). The numeric-op comments already explain "JS has one
number type" — the `float64`/`int` spellings contradict that.

---

## 3. Internal inconsistencies

### 3.1 Inconsistent quoting of model responses in error/retry text
- `src/ai/ops.ts` uses `goQuote(raw)` in some places (`:58,109,127`) but bare
  template `"${raw}"` in others (`:169,240,302,365`, and `aiScore`/`aiBestMatch`/
  `aiRerank` non-reasoning branches).

`goQuote` exists precisely to escape embedded newlines/quotes so a prior response
can't corrupt the next prompt — but half the call sites bypass it with raw
interpolation. Route all of these through `goQuote` (or drop it everywhere).

### 3.2 Three copies of `errMsg`
- `src/mcp/util.ts:34`, `src/rag/retrieve.ts:22`, `src/rag/embedding.ts:21`

Identical `err instanceof Error ? err.message : String(err)` helper defined three
times. Hoist one shared helper (e.g. into a small `src/internal/error.ts`).

### 3.3 Two divergent `escapeXmlText` implementations
- `src/ai/repair.ts:109-119` escapes `"`→`&quot;`, `'`→`&apos;`
- `examples/rag-common.ts:82-117` escapes `"`→`&#34;`, `'`→`&#39;`

Two functions with the same name and purpose but different output. The
API-CHANGES note calls this "intentional" (different scope), but it's still a
foot-gun. At minimum cross-reference them; better, export one canonical XML-text
escaper from the library and have the example use it.

### 3.4 Duplicated regex-compile-and-validate logic
- `src/ops/text.ts:78-90` has a reusable `compilePattern(opName, pattern)` helper
- `src/ops/predicate.ts:68-80` re-implements the same compile/empty/invalid logic
  inline for `ifStringRegexMatch`

`predicate.ts`'s `ifStringRegexMatch` and `text.ts`'s `regexMatch` are nearly
identical. Reuse `compilePattern` from `text.ts` (or move it to a shared spot) so
the error-message format and behavior can't drift.

### 3.5 Two `q`/`goQuote`/`quote` aliases for `JSON.stringify`
- `src/ops/json.ts:40` (`q`), `src/ai/compute.ts:153` (`goQuote`),
  `examples/with-repair.ts:59` (`q`), `examples/local-mcp-server.ts:147` (`q`)

The same one-liner is redefined under three names. Consolidate to one exported
diagnostic-quote helper.

### 3.6 Example entrypoint guards are inconsistent
- `examples/rag-bm25.ts:203` and `examples/rag-gemini-embed.ts:262` wrap `main()`
  in `if (require.main === module)`.
- Every other example calls `main().catch(...)` unconditionally.

The guard is defensible (these two files `export` classes the tests import), but
the inconsistency is worth a one-line comment, and note that
`require.main === module` is a CommonJS idiom that is brittle under ESM/tsx — the
tests should ideally import from a separate module so the example entry file can
stay uniform.

### 3.7 `aiParseNumber` free function takes a required-but-nullable `opts`
- `src/ai/ops.ts:449-453` — `opts: (AIOpOptions & { operation?: string }) | undefined`

Every other free op takes `opts` as a required object; the node constructor
`parseNumber` (`src/ai/graph.ts:244`) correctly uses `opts?`. Make the free
function `opts?: AIOpOptions & { operation?: string }` for a consistent,
idiomatic optional parameter instead of forcing callers to pass `undefined`.

---

## 4. API-surface gaps / asymmetry

### 4.1 `withRepair` has no `wf.ai.*` node constructor
- `src/ai/graph.ts` (AINamespace) covers every AI op **except** `withRepair`.
- Consequence: `examples/with-repair.ts:166-195` still hand-wraps it in `wf.op`,
  declares the input twice, and couriers `ctx` — exactly the boilerplate S2/S4
  removed for every other op.

Add a `wf.ai.repair(input, cfg)` constructor (mirroring the other namespace
methods) so the repair op is a first-class node like the rest, and simplify the
example.

### 4.2 `Pool` is exported as public API but is an internal semaphore
- `src/index.ts:24` exports `Pool`; `src/pool.ts` is a concurrency primitive the
  engine uses internally.

Exposing it widens the public surface with something most consumers won't use and
that constrains future refactors. Consider dropping it from the package root (or
documenting it as intentionally public).

### 4.3 `MockAIClient.call` ignores the abort signal
- `src/ai/client.ts:209-213`

`AIClient.call(req, signal?)` is the contract, but the mock drops `signal`. A test
that aborts mid-run won't see the mock cancel, which can mask abort-handling bugs
or hang. Have the mock reject when `signal?.aborted`.

---

## 5. Non-idiomatic / cleanup

### 5.1 Library logs directly to `console` instead of through its `Logger`
- `src/ai/client.ts:116` (`console.warn` on empty Gemini response)
- `src/ai/factory.ts:77`, `src/rag/embedding.ts:172`, `src/rag/retrieve.ts:177`,
  `src/mcp/call.ts:184,222`, `src/mcp/script.ts:140,155`, `src/mcp/pool.ts:103`

The library already defines a `Logger` abstraction (`src/types.ts:79`) and a
reasoning sink, yet warnings/diagnostics are written straight to `console.warn`.
For an embeddable library this is noisy and unconfigurable. Route operational
warnings through an injectable logger (or at least a single internal `warn()`
shim) so hosts can silence/redirect them. Note also the lone
`// eslint-disable-next-line no-console` in `src/ops/io.ts:19-20` — there's no
ESLint config in the repo, so the directive is dead.

### 5.2 `isTransientError` substring list has gaps and redundancy
- `src/ai/client.ts:123-137`

Matches `"503"` but not `500`/`502`/`504`; includes both `"unavailable"` and
`"service unavailable"` (the latter is subsumed by the former). Tighten to the
distinct status families (5xx, 429) and drop the redundant phrase.

### 5.3 Overlapping string helpers
- `src/ops/text.ts:5` `concat(...parts)` vs `:59` `stringConcat(a, b)`

Two near-duplicate concatenation helpers (one variadic "compose" helper, one
two-arg "catalog op"). Fine to keep both, but a one-line note on why they coexist
would prevent future "dead code?" churn.

### 5.4 Naming collision: two unrelated `zip`s
- `src/workflow.ts:251` (`Workflow.zip`, element-wise tuples of array *nodes*)
- `src/ops/slice.ts:16` (`zip<A,B>`, a 2-array positional helper)

Different layers, but the identical name invites confusion. Consider renaming the
`slice.ts` helper (e.g. `zip2`/`pairwise`) since the workflow-level `zip` is the
headline API.

### 5.5 The `aiVertices` "parallel array" pattern persists despite Finding E
- `examples/ticket-triager.ts:256-265,315`,
  `examples/recipe-analyzer.ts:213-214`,
  `examples/weather-advisor.ts:132,189`,
  `examples/hn-topic-brief.ts:144,213`,
  `examples/readme-quality.ts:126,195`

These examples carry a hand-maintained `aiVertices: Node[]` array and compute
fired nodes via `aiVertices.filter((n) => !result.skipped(n)).map((n) => n.name)`
— while their comments cite "Finding E" and claim they avoid exactly this. S1.1
added `RunResult.firedNodes()` for this. The array is needed to *restrict* the
report to AI nodes (so a bare `firedNodes()` would over-report), but the comments
oversell the resolution. Either (a) tag AI nodes via a naming convention and use
`firedNodes()`, or (b) soften the comments to say the array is the AI-node subset,
not a removed smell.

### 5.6 `withRepair` only emits a reasoning record on the repaired path
- `src/ai/repair.ts:228-235` (first-try success returns with no `logger.log`) vs
  `:274-280` (logs only after a repair cycle)

In reasoning mode, a ticket that validates first try produces no reasoning entry,
while a repaired one does — so the reasoning trace is present/absent depending on
whether repair happened. If reasoning records are meant to be uniform, log a
"no repair needed" entry on the success path too.

### 5.7 Minor: combine duplicate `node:fs` imports
- `examples/local-mcp-server.ts:35-36` imports `mkdirSync` and `statSync` from
  `node:fs` on two separate lines. Merge into one import.

---

## 6. Things checked and found OK (for reviewer confidence)

- `Pool` semaphore release/acquire accounting is correct (no double-credit).
- `engine.ts` skip-propagation, cycle check, abort plumbing, and per-op `withAI`
  swap are sound; reduce-seed `structuredClone` snapshotting is correct.
- `withDeadline` parent/timer wiring and listener cleanup are correct.
- MCP pool `inflight` accounting decrements on exactly one terminal path per
  worker; shutdown drains `pending`.
- `validateCitations`, `parseStaticFilters`, `jsonExtract` path traversal, and
  `sliceTopK` tie-breaking behave as documented.
- `xmlCodec` encode/decode escape ordering (`&` first on encode, `&amp;` last on
  unescape) is correct.

---

### Suggested fix order
1. Section 1 (bugs) — especially 1.1, 1.2, 1.3, which break real runs/docs.
2. Section 2 (stale docs) and Section 3 (inconsistencies) — cheap, high-signal.
3. Section 4.1 (`wf.ai.repair`) — the one remaining API asymmetry.
4. Sections 4.2–5 — polish toward idiomatic TS.
