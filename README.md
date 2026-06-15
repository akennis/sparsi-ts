# sparsi-ts

**Build AI workflows the way you build software.** sparsi-ts lets you wire deterministic logic and LLM calls into one typed, concurrent DAG — so the parts that *should* be reliable stay reliable, the parts that need a model are isolated and observable, and the whole thing runs in parallel with full TypeScript type inference end to end.

No prompt spaghetti. No orchestration glue. Just typed nodes that compose.

```ts
const wf = new Workflow();
const ticket = wf.input<string>("ticket");

const category = wf.ai.modeSelect(ticket, { categories: ["billing", "bug", "feature"] });
const summary  = wf.ai.compute(ticket, { operation: "summarize in one sentence", output: "string" });
const severity = wf.ai.score(ticket, { criterion: "production impact, 1.0 = blocking" });

const result = await wf.run({ ai: new ai.AnthropicClient(), values: { ticket } });
result.get(category); // "bug"   — fully typed, three AI calls run concurrently
```

---

## Why sparsi-ts

- **Deterministic where it counts.** Math, string ops, predicates, JSON extraction, time, and IO are plain, testable functions — not LLM calls. AI is opt-in, node by node.
- **AI as a first-class operator.** `wf.ai.score`, `wf.ai.classifyMultiLabel`, `wf.ai.extractMap`, `wf.ai.bestMatch`, and friends take typed input nodes and return typed output nodes. The engine threads the model client and parses/validates the response for you.
- **It's a real DAG.** Nodes declare their dependencies; the engine runs independent branches concurrently, validates the graph is acyclic, and propagates *skips* so conditional branches cost nothing when they don't fire.
- **Typed end to end.** Wiring a node's output into the wrong input is a compile error. `coalesce` returns the *union* of its branch types; `zip` returns typed tuples; `map`/`filter`/`reduce` stay element-typed.
- **Batteries included.** Retrieval-augmented generation (`wf.rag.*`), Model Context Protocol tools (`wf.mcp.*`), Anthropic + Gemini clients, retries, reasoning capture, and an AI-driven repair wrapper all ship in the box.
- **Build once, run many.** Constructing a workflow is pure — nothing executes until `wf.run()`. Run the same graph against different inputs, clients, or concurrency limits.

---

## Install

```bash
npm install sparsi-ts
```

Requires Node 18+ (uses `structuredClone`, the built-in test runner, and `AbortSignal`). For AI ops, set a provider key:

```bash
export CLAUDE_API_KEY=sk-...     # Anthropic (default provider)
export GEMINI_API_KEY=...        # Google Gemini (optional)
```

---

## Quickstart

### 1. A deterministic workflow — no API key needed

```ts
import { Workflow, ops } from "sparsi-ts";

const wf = new Workflow();
const temps = wf.input<number[]>("temps");

const mean = wf.op({ temps }, ({ temps }) => ops.num.round(ops.num.mean(temps), 1));

// Three mutually exclusive lanes, each gated by a condition on the mean.
const cold = wf.op({ mean }, ({ mean }) => `Avg ${mean}°C — bundle up.`,
  { condition: ({ mean }) => mean < 10 });
const mild = wf.op({ mean }, ({ mean }) => `Avg ${mean}°C — a light jacket.`,
  { condition: ({ mean }) => mean >= 10 && mean < 25 });
const hot  = wf.op({ mean }, ({ mean }) => `Avg ${mean}°C — stay hydrated.`,
  { condition: ({ mean }) => mean >= 25 });

// Exactly one lane runs; coalesce picks the one that fired.
const advice = wf.coalesce([cold, mild, hot]);

const result = await wf.run({ values: { temps: [4, 7, 9, 12, 6, 3, 8] } });
console.log(result.get(advice)); // "Avg 7°C — bundle up."
```

### 2. Add AI

```ts
import { Workflow, ai } from "sparsi-ts";

const wf = new Workflow();
const text = wf.input<string>("text");

const hasPII   = wf.ai.bool(text, { predicate: "does this text contain PII?" });
const keywords = wf.ai.extractStringSlice(text, { operation: "extract the key topics" });
const tldr     = wf.ai.summarize(keywords, { operation: "summarize into one phrase" });

const result = await wf.run({
  ai: new ai.AnthropicClient(),       // reads CLAUDE_API_KEY
  values: { text: "…" },
  concurrency: 10,                    // cap parallel ops
});

result.get(hasPII);   // boolean
result.get(keywords); // string[]
result.get(tldr);     // string
```

---

## Core concepts

### The Workflow

A `Workflow` is a graph builder. Each method returns a typed `Node<T>` handle you wire into later nodes. **Construction is pure** — nothing runs until `run()`, so a workflow can be built once and run many times.

| Builder | Produces | Purpose |
| --- | --- | --- |
| `wf.input<T>(key, opts?)` | `Node<T>` | An external value, resolved from `run({ values })` by `key`. Supports a `default`. |
| `wf.constant<T>(value)` | `Node<T>` | A literal available downstream. |
| `wf.source<O>(fn)` | `Node<O>` | A dependency-free producer — runs `fn(ctx)` and yields its value. |
| `wf.op(inputs, fn, opts?)` | `Node<O>` | The workhorse: a typed async function over a map of named input nodes. |
| `wf.coalesce([a, b, …])` | `Node<A \| B \| …>` | First non-skipped branch wins; merges mutually exclusive lanes. |
| `wf.zip([a, b, …])` | `Node<[A, B, …][]>` | Combines array nodes element-wise into typed tuples. |
| `wf.map(arr, fn)` | `Node<O[]>` | Maps over an array node's elements. |
| `wf.filter(arr, pred)` | `Node<T[]>` | Keeps elements matching a predicate. |
| `wf.reduce(arr, fn, init)` | `Node<A>` | Folds an array node into an accumulator. |

### Skips: conditional branches that cost nothing

Every node resolves to either a value or the `SKIP` sentinel. **Skips propagate downstream**: an op whose inputs include a skipped producer is itself skipped automatically. `coalesce` is the exception — it skips only when *every* source skipped, which is what makes it the natural join for conditional branches.

```ts
import { SKIP } from "sparsi-ts";

const maybe = wf.op({ x }, ({ x }) => x > 0 ? x : SKIP);
const dependent = wf.op({ maybe }, ({ maybe }) => maybe * 2); // skipped if `maybe` skipped
```

### Conditions and gates

An op can carry a `condition` that decides whether it runs at all. Use `gate` to give the condition access to values that *aren't* passed to the op's body — no identity passthrough node required.

```ts
const cls = wf.ai.modeSelect(ticket, { categories: ["billing", "bug"] });

const bugSteps = wf.ai.extractStringSlice(ticket, {
  operation: "extract the reproduction steps",
  gate: { cls },                                  // visible only to condition
  condition: (_inputs, { cls }) => cls === "bug", // skips unless classified as a bug
});
```

### Running

```ts
const result = await wf.run({
  ai,                       // run-wide AI client (override per-op with the `ai` option)
  values: { ... },          // resolves wf.input(...) nodes by key
  concurrency: 10,          // max ops in flight (default: unbounded)
  reasoning: true,          // capture AI reasoning out-of-band
  signal: abortController.signal,
  logger,                   // sink for reasoning records
});
```

The `RunResult` lets you read outcomes without parallel bookkeeping:

```ts
result.get(node);          // the value, or throws if the node skipped
result.getOr(node, fb);    // the value, or a fallback if skipped
result.skipped(node);      // boolean
result.nodes();            // every node: { id, name, kind, skipped, value }
result.firedNodes();       // just the nodes that produced a value
result.reasoning;          // ReasoningEntry[] captured in reasoning mode
```

---

## AI operators

Each `wf.ai.*` constructor takes input nodes and returns a typed output node. Common options: `model`, `maxRetries` (re-prompts on parse/validation failure), `name`, `ai` (per-op client override), `retry` (backoff on transient 5xx/429), plus `gate`/`condition`.

| Constructor | Output | What it does |
| --- | --- | --- |
| `wf.ai.modeSelect(input, { categories })` | `string` | Classify into exactly one of a fixed set. |
| `wf.ai.classifyMultiLabel(input, { categories })` | `string[]` | Zero or more labels. |
| `wf.ai.bool(input, { predicate })` | `boolean` | Yes/no question about the input. |
| `wf.ai.score(input, { criterion })` | `number ∈ [0,1]` | Measure a criterion (relevance, severity, toxicity…). |
| `wf.ai.compute(input, { operation, output })` | `string`/`number`/… | General string→value computation. |
| `wf.ai.parseNumber(input, opts?)` | `number` | Pull a number out of free text (`"$1.2k"` → `1200`). |
| `wf.ai.extractStringSlice(input, { operation })` | `string[]` | Extract a list from text. |
| `wf.ai.extractMap(input, { operation })` | `Record<string,string>` | Extract key/value fields. |
| `wf.ai.summarize(input, { operation })` | `string` | Summarize a list of strings into one. |
| `wf.ai.bestMatch(query, candidates)` | `number` | Index of the best-matching candidate. |
| `wf.ai.rerank(query, candidates)` | `number[]` | Candidate indices, best first. |
| `wf.ai.repair(input, { run, codec })` | `O` | AI-driven recovery wrapper (see below). |

### Providers

```ts
import { ai } from "sparsi-ts";

new ai.AnthropicClient();                               // CLAUDE_API_KEY, default claude-sonnet-4-6
new ai.AnthropicClient({ apiKey, model });
new ai.GeminiClient({ apiKey, model });                 // GEMINI_API_KEY
new ai.MockAIClient(handler);                           // deterministic, for tests
```

**Mix providers in one graph.** The run-wide `ai` is the default; any op can override it with the `ai` option — e.g. have Claude write a summary and Gemini independently verify it:

```ts
const summary = wf.ai.compute(doc, { operation: "summarize", output: "string" }); // Claude (run default)
const faithful = wf.ai.bool(prompt, {
  predicate: "is every claim grounded in the source?",
  ai: new ai.GeminiClient(),                                                       // second model verifies
});
```

For per-team billing or credential stores, register an `AIClientFactory` and resolve clients by `ref` via `ai.newAIClient({ provider, ref })`.

### Reasoning mode

Run with `{ reasoning: true }` and AI ops capture the model's reasoning out-of-band on `result.reasoning` — each entry carries the node name, the produced result, and a snapshot of the op's inputs. The returned *values* stay clean; the rationale rides alongside.

### AI-driven repair

`wf.ai.repair` wraps a deterministic function: when your code throws an `ErrRepairable` (a JSON parse error, a schema violation, a business-rule failure), the wrapper hands the LLM a self-contained prompt, parses the response back through a codec (`textCodec`, `jsonCodec`, `xmlCodec`), and re-runs — turning brittle parsing into self-healing parsing.

---

## Retrieval-augmented generation (`wf.rag.*`)

A `Retriever` contract plus retrieval ops, with citation validation that drops hallucinated sources.

```ts
import { Workflow, ai, rag } from "sparsi-ts";

rag.setDefaultRetriever(myRetriever);          // any BM25 / vector / external backend

const wf = new Workflow();
const question = wf.input<string>("question");

const retrieved = wf.rag.retrieve(question, { k: 3 });
const documents = wf.op({ retrieved }, ({ retrieved }) => retrieved.documents);
const answer    = wf.ai.compute(prompt, { operation: "answer, grounded in context", output: "string" });
const validated = wf.rag.validateCitations(citedSources, allowedSources); // keep only retrieved sources
```

Retrievers are pluggable: implement `Retriever` (the examples ship an in-memory BM25 index and a Gemini-embedding cosine retriever). Embedding clients follow the same factory pattern as AI clients, including per-request credential routing.

---

## Model Context Protocol tools (`wf.mcp.*`)

Call MCP tools — over stdio (subprocess) or streamable HTTP — as graph nodes.

```ts
import { Workflow, mcp } from "sparsi-ts";

// One tool call against a remote HTTP MCP server (no subprocess, no keys):
const search = wf.mcp.call(query, {
  transport: "http",
  url: "https://docs.mcp.cloudflare.com/mcp",
  tool: "search_cloudflare_documentation",
  output: "string",
});

// A scripted multi-call session over one long-lived stdio connection:
const results = wf.mcp.script(query, { /* spec + callback driving many tool calls */ });
```

`wf.mcp.call` does one tool call per run (fresh session, or a pooled stdio subprocess); `wf.mcp.script` drives many calls over one long-lived session. Pool prewarming and validation happen at build time, so they can't be forgotten.

---

## The deterministic op catalog

Pure, synchronous helpers under `ops.*`, ready to drop into any `wf.op` body:

- **`ops.num`** — add, sub, mul, div, pow, mod, round, clamp, trunc, sum, min, max, mean
- **`ops.text`** — casts, lookup, lower, concat, split, regex match/extract
- **`ops.bool`** — not, and, or
- **`ops.predicate`** — numeric (gt/lt/eq/ge/le), string (contains/prefix/suffix/regex/eq), empty/range checks
- **`ops.select`** — select/switch/default over strings, numbers, bools
- **`ops.slice`** — len, at, first, last, contains, join, filterEq, topK
- **`ops.json`** — extract by path
- **`ops.io`** — file read, env, HTTP GET
- **`ops.time`** — city time

Call `ops.allDescriptions()` for a formatted, grouped catalog of every operator's options, inputs, and outputs — handy for building tool palettes or LLM prompts.

---

## Examples

Sixteen runnable examples live in [`examples/`](examples/), each a self-contained, well-commented CLI. Run any with `npm run example:<name>`:

| Example | Demonstrates |
| --- | --- |
| `example:temperature` | Deterministic only — conditions, coalesce, map/filter. **No API key.** |
| `example:ticket` | Conditional AI lanes, gates, per-cost-center client factory, typed `coalesce` union. |
| `example:weather` | Live API + AI parsing, multi-label classification, deterministic banding. |
| `example:recipe` | Gemini extractors fan-out, difficulty scoring, gated advice lanes. |
| `example:stock` | Gemini — live quotes, sentiment scoring, Buy/Hold/Sell recommendation. |
| `example:faithful` | **Mix Claude + Gemini** in one graph for summarization faithfulness. |
| `example:hn` | `map` fan-out over stories, dominant-category compute, style selection. |
| `example:readme` | Five concurrent quality probes, averaged scoring, narrative lanes. |
| `example:repair` | `withRepair` — string and XML-struct self-healing parse/validate. |
| `example:rag-bm25` | RAG over a local KB with a BM25 retriever + citation validation. |
| `example:rag-gemini-embed` | RAG with Gemini embeddings + cosine retrieval. |
| `example:local-mcp` | Local stdio MCP (playwright) — search + screenshot, pooled subprocesses. |
| `example:remote-mcp` | Remote HTTP MCP against the public Cloudflare docs server. |
| `example:runner` | A workflow that runs the *other* examples and AI-diagnoses failures. |

---

## Development

```bash
npm install
npm test          # 262 tests across the engine, ops, AI, RAG, and MCP
npm run typecheck # strict tsc, no emit
npm run build     # emit to dist/
```

The codebase is layered so the core never imports a provider SDK:

```
src/
  workflow.ts   engine.ts   types.ts   # pure DAG core
  ops/                                  # deterministic operators
  ai/                                   # AI ops + Anthropic/Gemini/Mock clients
  rag/                                  # Retriever contract, embeddings, retrieval ops
  mcp/                                  # MCP transport, sessions, pool, ops
```

The `ai`, `rag`, and `mcp` namespaces install their `wf.ai` / `wf.rag` / `wf.mcp` accessors by augmenting `Workflow.prototype` on import — so the core stays SDK-free and tree-shakeable, and the fluent node constructors light up as soon as you import the namespace.

---

## License

MIT
