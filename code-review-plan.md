# Code Review — Execution Plan

Batches the findings in `code-review.md` into groups sized for one clean context
window each. Each group lists its findings, the files it touches, why those
findings travel together, and ordering constraints. Run **G1 first** and **G7
last**; G2–G6 are largely independent.

**Three standing decisions** (apply across all groups):
1. **`goQuote`/`q` helpers are deleted, not renamed.** They are all
   `(s) => JSON.stringify(s)`; inline `JSON.stringify(x)` at every call site and
   remove the definitions. (Subsumes findings 3.1 and 3.5.)
2. **XML is library-driven via `fast-xml-parser`** (new `dependency`). Delete all
   hand-rolled escape/parse code; no hand-coded XML.
3. **Gemini chat default is `gemini-3.1-flash-lite`** everywhere a generation
   model is named. Leave the embedding model `gemini-embedding-001` alone.
   (This retracts finding 1.3 — the id is intended, not invalid.)

---

## G1 — Critical bug sweep *(do first; trivial, run-breaking)*
- **1.1** MCP retry off-by-one — `src/mcp/call.ts:223`: `${cfg.maxRetries}` →
  `${cfg.maxRetries + 1}` (match `script.ts:141`).
- **1.2** MCP output-kind doc — `src/mcp/call.ts:42-44`: `"bool"` → `"boolean"`,
  add `"map"`.
- **1.4** `RunResult.skipped()` vs `get()`/`getOr()` asymmetry —
  `src/engine.ts:331-333`: return `r === undefined || isSkip(r)`.
- Files: `src/mcp/call.ts`, `src/engine.ts`.
- Why: surgical one-liners across disjoint files; ships the highest-urgency fixes.

## G2 — AI compute/ops file cleanup
- **goQuote elimination** — delete `goQuote` (`src/ai/compute.ts:153`) and inline
  `JSON.stringify` at the 7 sites (compute.ts ×1, ops.ts ×6); drop the import.
  Absorbs **3.1** (consistent quoting).
- **1.5** `aiScore` reasoning-mode default-0 vs non-reasoning retry — make both
  branches consistent (or document the default).
- **2.1** misplaced JSDoc above `goQuote`/`describeInput` — moot once goQuote is
  gone; ensure `describeInput` keeps its doc comment.
- **3.7** `aiParseNumber` free fn — `opts?` instead of required-nullable.
- Files: `src/ai/ops.ts`, `src/ai/compute.ts`.
- Why: all in two files; no cross-layer coupling (`goQuote` isn't re-exported).

## G3 — Documentation/description accuracy + tiny exports
- **2.3** AI op `Output:` lines claim `{result, reasoning}`; ops return the bare
  value — state the real return type.
- **2.4 (description part)** TS vocabulary in desc consts (`int`/`float64`/`*` →
  TS); rename `AIComputeMathOperandsToFloat64Op…` const (ripples to
  `ai/index.ts` + `ops/descriptions.ts` aggregator).
- **5.4** rename `slice.ts` `zip` → `zip2`/`pairwise` (avoid clash with
  `Workflow.zip`).
- **4.2** drop `Pool` from the package root (`src/index.ts`).
- Files: `src/ai/descriptions.ts`, `src/ops/*.ts` (desc consts), `src/ops/slice.ts`,
  `src/ai/index.ts`, `src/ops/descriptions.ts`, `src/index.ts`.
- Why: near-pure string/export edits plus one const rename + its ripple.

## G4 — Shared-helper dedup (DRY)
- **3.2** consolidate three `errMsg` copies (`mcp/util.ts`, `rag/retrieve.ts`,
  `rag/embedding.ts`) into one shared helper.
- **3.4** reuse `text.ts`'s `compilePattern` in `predicate.ts`'s
  `ifStringRegexMatch`.
- **3.5 (json.ts part)** delete the `q` alias in `src/ops/json.ts:40`; inline
  `JSON.stringify`. Also fold in the ops-layer `goTypeName`→`jsonTypeName` rename
  + TS type names in its error strings (2.4 code part).
- **5.3** add a one-line note on why `concat` and `stringConcat` coexist.
- Files: shared helper home, `src/mcp/util.ts`, `src/rag/{retrieve,embedding}.ts`,
  `src/ops/{text,predicate,json}.ts`.
- Why: one coherent "create canonical helper / kill duplicate" pass.
- Order: **before G7** (both touch `retrieve.ts`/`embedding.ts`).

## G5 — Repair subsystem *(keeps `repair.ts` in one window)*
- **3.3 + decision 2** replace `repair.ts`'s `escapeXmlText`/`xmlUnescape` and the
  regex `xmlCodec`, and `rag-common.ts`'s `escapeXmlAttr`/`escapeXmlText`/
  `isInCharacterRange`, with **`fast-xml-parser`** (XMLBuilder/XMLParser); delete
  all five hand-rolled fns; add `fast-xml-parser` to `package.json`.
- **2.2** `WithRepairDescription` "parse callback" → "RepairCodec".
- **4.1** add `wf.ai.repair` node constructor; simplify `examples/with-repair.ts`.
- **5.6** emit a reasoning record on the first-try-success path too.
- **3.5 (example part)** delete the `q` alias in `examples/with-repair.ts:59`.
- Files: `src/ai/repair.ts`, `src/ai/graph.ts`, `src/ai/index.ts`,
  `examples/with-repair.ts`, `examples/rag-common.ts`, `package.json`.
- Why: keeps the most-touched non-trivial file in a single window; the XML lib,
  node constructor, and example simplification are interdependent.

## G6 — Examples polish
- **3.6** unify rag entry-point guards (`require.main === module`) with the rest.
- **5.5** `aiVertices` parallel-array pattern — adopt `firedNodes()` or soften the
  "Finding E" comments.
- **5.7** merge the duplicate `node:fs` import in `local-mcp-server.ts`.
- **3.5 (example part)** delete the `q` alias in `examples/local-mcp-server.ts:147`.
- Files: `examples/{ticket-triager,recipe-analyzer,weather-advisor,hn-topic-brief,
  readme-quality,rag-bm25,rag-gemini-embed,local-mcp-server}.ts`.
- Why: example-only; independent of library groups.

## G7 — Client behavior + cross-cutting logging *(do last)*
- **decision 3** `GeminiClient` default → `gemini-3.1-flash-lite`
  (`src/ai/client.ts:77`). Leave embedding model.
- **4.3** `MockAIClient.call` honors `signal`.
- **5.2** tighten `isTransientError` (5xx family, drop redundant phrase).
- **5.1** route operational `console.warn`s through an injectable logger / internal
  `warn()` shim; remove the dead `eslint-disable` in `ops/io.ts`.
- Files: `src/ai/{client,factory}.ts`, `src/rag/{embedding,retrieve}.ts`,
  `src/mcp/{call,script,pool}.ts`, `src/ops/io.ts`.
- Why: 5.1 is the one invasive change and re-touches files edited by G1/G4 — last
  so it reads their final state. Other `client.ts` items ride along.

---

## Ordering & shared-file notes
- **Order:** G1 → (G2, G3, G4, G5 any order) → G6 → **G7 last**.
- **Hard sequencing:** G7 after G1 (`call.ts`) and after G4 (`retrieve.ts`/
  `embedding.ts`).
- **Benign within-window overlaps** (sequential, no conflict): `json.ts`/`text.ts`
  in G3 (desc consts) + G4 (logic); `ai/index.ts` in G3 + G5; `recipe-analyzer.ts`
  in G1-retired/G6.
- **Layering:** `ops/*` must not import from `ai/*` — keep any shared helper in a
  layer-neutral `src/internal/*`.
- Section 6 of `code-review.md` ("checked and OK") needs no work.
- After each group: `npm run typecheck` and `npm test` must stay green.

## Status
- [x] G1 — done (1.1, 1.2, 1.4; 262/262 tests pass, typecheck clean)
- [x] G2 — done (goQuote eliminated + 3.1 consistent quoting, 1.5, 2.1, 3.7; 262/262 tests pass, typecheck clean)
- [x] G3 — done (2.3 bare-value Output lines + reasoning note, 2.4 desc TS vocabulary across all ops + `AIComputeMathOperandsToFloat64Op`→`…ToNumberOp` rename, 5.4 `slice.zip`→`zip2`, 4.2 dropped `Pool` from package root; 262/262 tests pass, typecheck clean)
- [x] G4 — done (3.2 `errMsg` consolidated into `src/internal/error.ts`; 3.4 `predicate.ifStringRegexMatch` reuses `text.compilePattern`; 3.5 dropped `json.ts` `q` alias + `goTypeName`→`jsonTypeName` with TS type names; 5.3 coexistence note on `concat`/`stringConcat`; 262/262 tests pass, typecheck clean)
- [x] G5 — done (3.3 + decision 2: `fast-xml-parser` replaces all 5 hand-rolled XML fns in `repair.ts`/`rag-common.ts`, `XMLBuilder` output is byte-identical so `repair.test.ts` unchanged, only rag entity assertion `&#34;`→`&quot;`; 2.2 desc "parse callback"→RepairCodec; 4.1 `wf.ai.repair` node + simplified example; 5.6 "no repair needed" reasoning on first-try path; 3.5 dropped `q` alias in with-repair.ts; 262/262 tests pass, typecheck clean, example runs offline)
- [x] G6 — done (3.6 documented the deliberate `require.main === module` guards on both rag examples — kept, since their tests import the exported retrievers and the package is CJS; 5.5 softened the `aiVertices` comments across ticket-triager/recipe-analyzer/weather-advisor/hn-topic-brief/readme-quality to frame the array as the AI-node subset that restricts the fired-node report, noting a bare `firedNodes()` would over-report; 5.7 merged the duplicate `node:fs` import + 3.5 dropped the `q` alias in local-mcp-server.ts; 262/262 tests pass, typecheck clean)
- [x] G7 — done (decision 3 `GeminiClient` default → `gemini-3.1-flash-lite`; 4.3 `MockAIClient.call` honors `signal` — rejects with `signal.reason` when already aborted; 5.2 tightened `isTransientError` to the 5xx family `500/502/503/504` + `429` and dropped redundant `"service unavailable"`; 5.1 added injectable `src/internal/warn.ts` shim (`warn`/`setWarn`, exported from package root), routed all 8 operational `console.warn`s through it across ai/client, ai/factory, rag/embedding, rag/retrieve, mcp/{call,script,pool}, and removed the dead `eslint-disable` in `ops/io.ts` (catalog `print` keeps `console.log`); 262/262 tests pass, typecheck clean)
