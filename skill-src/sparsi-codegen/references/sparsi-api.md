# sparsi-ts API Reference

This is the **authoritative API reference** for code generation. If an API is not listed here or in
`references/library.md`, treat it as non-existent — do NOT invent methods on `Workflow`, `RunResult`,
or any namespace. Everything is imported from the installed package:

```ts
import { Workflow, ops, ai, rag, mcp, SKIP } from "sparsi-ts";
import type { Node, RunResult, RunContext, AIClient } from "sparsi-ts";
```

There is **no graph builder DSL, no string wire names, no operator registration, and no
`context.WithValue`**. A workflow is a tree of typed `Node<T>` handles produced by `Workflow` methods;
the engine resolves them concurrently. This is the central difference from sparsi-go — the same design
concepts (deterministic-first, conditional skip-propagation, coalesce joins, map fan-out, AI ops, RAG,
MCP) are expressed as typed node constructors instead of registered ops wired by string.

---

## The Workflow builder — `new Workflow()`

Construction is **pure**: every method below records a node and returns a `Node<T>` handle. Nothing
executes until `wf.run()`. Build once, run many times.

```ts
wf.input<T>(key: string, opts?: { default?: T; name?: string }): Node<T>
```
An external value, resolved from `run({ values })` by `key`. If the key is absent at run time and no
`default` was given, the run fails. **This is the only way external runtime values enter the DAG** —
there is no `setInput`/`setWire`. CLI flags, file contents, env values all flow in through `values`.

```ts
wf.constant<T>(value: T, name?: string): Node<T>
```
A compile-time literal available downstream. Use for true constants (thresholds, fixed config).

```ts
wf.source<O>(fn: (ctx: RunContext) => O | Skip | Promise<O | Skip>, opts?): Node<O>
```
A dependency-free producer — runs `fn(ctx)` and yields its value. The idiomatic spelling of "produces
a value from nothing but ctx" (e.g. a one-off HTTP fetch resolved in-graph).

```ts
wf.op<D, O, G>(inputs: D, fn: OpFn<D, O>, opts?: OpDefOptions<D, G>): Node<O>
```
The workhorse: a typed async function over a map of named input nodes. `inputs` is an object of
`Node<…>`; `fn` receives `(resolvedInputs, ctx)` where `resolvedInputs` has the same keys with values
unwrapped. Returns `Node<O>` where `O` is `fn`'s return type. Skips automatically if any input skipped,
or if `opts.condition` returns false.

```ts
wf.coalesce<S extends readonly Node<any>[]>(sources: S, opts?): Node<union of branch types>
```
First non-skipped source wins. Skips only when *every* source skipped. The natural join for mutually
exclusive conditional lanes. The result type is the **union** of the branch value types — branches may
have different shapes.

```ts
wf.zip<S>(sources: [...S], opts?): Node<tuple[]>
```
Combines several array nodes element-wise into one array of typed tuples, truncating to the shortest.
`zip([titles, flags])` over `Node<string[]>` and `Node<boolean[]>` yields `Node<[string, boolean][]>`.

```ts
wf.map<T, O>(source: Node<T[]>, fn: (item: T, ctx: RunContext) => O | Promise<O>, opts?): Node<O[]>
wf.filter<T>(source: Node<T[]>, pred: (item: T, ctx: RunContext) => boolean | Promise<boolean>, opts?): Node<T[]>
wf.reduce<T, A>(source: Node<T[]>, reducer: (acc: A, item: T, ctx) => A | Promise<A>, initial: A, opts?): Node<A>
```
Array combinators. `map` fans out concurrently over the elements. `reduce`'s `initial` is required and
snapshotted per run. Inside a `map`/`reduce` body you may call AI ops via `ctx` (see `local-mcp-server`
and the RAG examples).

```ts
wf.run(opts?: RunOptions): Promise<RunResult>
```
Executes the graph. See below.

### OpOptions / OpDefOptions

`wf.op` (and the AI/RAG/MCP node constructors) accept:
- `name?: string` — node name; also the reasoning-record label and the log identifier.
- `onError?: "stop" | "continue"` — default `"stop"`. `"continue"` makes a throwing op skip instead of
  aborting the run (use sparingly, e.g. best-effort per-item work).
- `condition?: (inputs, gate, ctx) => boolean | Promise<boolean>` — gates whether the op runs. Returns
  false → the op is skipped without running its body.
- `gate?: G` — extra nodes (a `NodeMap`) visible **only** to `condition`, never passed to the op body.
  A skipped gate node skips the op. This removes the need for an identity passthrough node just to make
  a value visible to a condition.

```ts
const cls = wf.ai.modeSelect(ticket, { categories: ["billing", "bug"] });
const bugSteps = wf.ai.extractStringSlice(ticket, {
  operation: "extract the reproduction steps",
  gate: { cls },
  condition: (_inputs, { cls }) => cls === "bug",   // skips unless classified bug
});
```

---

## SKIP — conditional branches that cost nothing

Every node resolves to a value or the `SKIP` sentinel (`import { SKIP } from "sparsi-ts"`). **Skips
propagate downstream**: an op whose inputs include a skipped producer is itself skipped. `coalesce` is
the exception (skips only when every source skips). Return `SKIP` from a `wf.op` body to skip
conditionally from inside the function:

```ts
const maybe = wf.op({ x }, ({ x }) => (x > 0 ? x : SKIP));
const dependent = wf.op({ maybe }, ({ maybe }) => maybe * 2); // skipped if `maybe` skipped
```

---

## Running — `wf.run(opts)`

```ts
const result = await wf.run({
  ai,                       // run-wide AI client (override per-op with the op's `ai` option)
  values: { key: value },   // resolves wf.input(key) nodes
  concurrency: 10,          // max ops in flight (default: unbounded)
  reasoning: true,          // capture AI reasoning out-of-band on result.reasoning
  signal: abortController.signal,
  logger,                   // sink for reasoning records
});
```

### RunResult

```ts
result.get(node)          // the value, or THROWS if the node skipped
result.getOr(node, fb)    // the value, or `fb` if skipped
result.skipped(node)      // boolean
result.nodes()            // every node: { id, name, kind, skipped, value }
result.firedNodes()       // just the nodes that produced a value
result.reasoning          // ReasoningEntry[] captured in reasoning mode
```

There are no other methods. To know whether a conditional branch ran, use `result.skipped(node)`;
never inspect engine internals.

---

## Deterministic op catalog — `ops.*`

Pure synchronous helpers to drop into `wf.op` bodies (full signatures in `references/library.md`):

- `ops.num` — `add, sub, mul, div, pow, mod, round, clamp, trunc, sum, min, max, mean`
- `ops.text` — casts (`numberToString`, `boolToString`, `toString`), `stringLookup`, `stringToLower`,
  `stringConcat`, `stringSplit`, `regexMatch`, `regexExtract`
- `ops.bool` — `not`, `and`, `or`
- `ops.predicate` — numeric (`ifGt/ifLt/ifEq/ifGe/ifLe`), string (`ifStringContains/HasPrefix/HasSuffix/RegexMatch/Eq`), `ifEmptyString`, `between`, …
- `ops.select` — `selectString/Number/Bool`, `switchString`, `defaultString/Number`
- `ops.slice` — `len, at, first, last, contains, join, filterEq, topK`
- `ops.json` — `jsonExtract(jsonText, path)` (dotted path with numeric indices, e.g. `"a.0.b"`)
- `ops.io` — `fileRead`, `env`, `httpGet(url)` → `{ statusCode, body }`
- `ops.time` — `cityTime`
- `ops.allDescriptions()` — the formatted catalog (this is what generates `library.md`)

Most of these are one-liners — prefer a plain expression in a `wf.op` body when it reads more clearly
(e.g. `({ a, b }) => a + b` over `ops.num.add(a, b)`); reach for `ops.*` when it names a non-obvious
operation (`ops.json.jsonExtract`, `ops.text.regexExtract`, `ops.io.httpGet`).

---

## AI ops — `wf.ai.*`

Each constructor takes input node(s) and returns a typed output node. Common options on every one:
`model`, `maxRetries` (re-prompt on parse/validation failure, default 3), `name`, `ai` (per-op client
override), `retry` (backoff on transient 5xx/429), plus `gate`/`condition`.

```ts
wf.ai.modeSelect(input: Node<string>, { categories: string[] }): Node<string>
wf.ai.classifyMultiLabel(input: Node<string>, { categories: string[] }): Node<string[]>
wf.ai.bool(input: Node<string>, { predicate: string }): Node<boolean>
wf.ai.score(input: Node<string>, { criterion: string }): Node<number>          // ∈ [0,1]
wf.ai.compute(input: Node<unknown>, { operation, output, validate?, expectedFormat?, formatInput? }): Node<…>
wf.ai.parseNumber(input: Node<string>, { operation? }): Node<number>
wf.ai.extractStringSlice(input: Node<string>, { operation }): Node<string[]>
wf.ai.extractMap(input: Node<string>, { operation }): Node<Record<string,string>>
wf.ai.summarize(items: Node<string[]>, { operation }): Node<string>
wf.ai.bestMatch(query: Node<string>, candidates: Node<string[]>): Node<number>
wf.ai.rerank(query: Node<string>, candidates: Node<string[]>): Node<number[]>
wf.ai.repair<T, O>(input: Node<T>, cfg): Node<O>                                // see "Repair" below
```

`wf.ai.compute`'s `output` fixes the returned node's value type: `output: "string"` → `Node<string>`,
`output: "number"` → `Node<number>`, etc. Pass a `validate(value)` callback that throws to force an
in-conversation re-prompt (within `maxRetries`); pass `expectedFormat` to tighten the format hint so
the first response parses.

### Clients & providers

```ts
new ai.AnthropicClient()                          // reads CLAUDE_API_KEY, default model claude-sonnet-4-6
new ai.AnthropicClient({ apiKey, model })
new ai.GeminiClient({ apiKey, model })            // reads GEMINI_API_KEY, default gemini-3.1-flash-lite
new ai.MockAIClient(handler)                       // deterministic, for tests
ai.withRetry(client, cfg?)                         // wrap a client to back off on transient 5xx/429
```

The run-wide client is `run({ ai })`. Any op overrides it with its own `ai` option — this is how you
mix providers in one graph (Claude writes, Gemini verifies). For per-team billing / credential stores,
implement `ai.AIClientFactory`, register it with `ai.setDefaultAIClientFactory` /
`ai.registerAIClientFactory`, and resolve clients by `ref` with `ai.newAIClient({ provider, ref })`.

### Reasoning mode

`run({ reasoning: true })` captures the model's reasoning out-of-band on `result.reasoning` (each entry
carries the node name, the produced result, and an input snapshot). The returned *values* stay clean.

---

## AI-driven repair — `wf.ai.repair`

Wraps a **deterministic** function. When `run` throws `ai.ErrRepairable`, the wrapper sends the LLM a
self-contained prompt, parses the response through `codec`, and re-runs `run` on the repaired value —
up to `maxAttempts` cycles. Clean input that parses first try makes zero LLM calls.

```ts
const ticket = wf.ai.repair<string, TicketInput>(raw, {
  run: (text) => parseTicket(text),     // throws `new ai.ErrRepairable(prompt, cause)` on a fixable miss
  codec: ai.textCodec(),                // text | json | xml — parses the LLM response back to the input type
  maxAttempts: 3,
  promptPrefix: "You are a strict JSON corrector. Output corrected JSON only.\n\n",
  name: "parse",
});
```

Codecs: `ai.textCodec()` (raw string target; the inner op parses it), `ai.jsonCodec()`,
`ai.xmlCodec<T>({ root, fields, optional })` (struct target via XML — preferred for record-shaped
repair payloads; the library owns the escaping/parsing). `ai.ErrRepairable`'s prompt MUST be
self-contained (include the offending input verbatim, the validation error, and the exact expected
shape) because `run` re-fires from scratch. The inner `run` MUST be pure/idempotent — it re-executes
on the repaired input; never wrap a function with side effects. See `with-repair/`.

---

## Retrieval (RAG) — `wf.rag.*`

```ts
rag.setDefaultRetriever(myRetriever);                  // or rag.registerRetriever("id", r)
const retrieved = wf.rag.retrieve(question, { k: 3 }); // Node<{ documents: Document[]; texts: string[] }>
const filtered  = wf.rag.retrieveWithFilters(question, { k: 5, staticFilters: { tenant: "acme" } });
const validated = wf.rag.validateCitations(citedSources, allowedSources); // Node<{ accepted: string[]; rejected: string[] }>
```

`Document` is `{ id: string; content: string; score: number; metadata?: Record<string, unknown> }`.
A `rag.Retriever` implements `retrieve(query, k, ctx): Promise<Document[]>`. Setup is fail-fast: if no
Retriever is registered the graph errors before any node runs. Retrieval options (`retrieverId`,
`credentialRef`, `clientFactoryId`, `factoryTimeoutMs`, `embedTimeoutMs`, `staticFilters`) are detailed
in `references/library.md`. Embedding-backed Retrievers resolve their client via
`rag.resolveEmbeddingClient(ctx, provider, model)`; the bundled `rag.EnvEmbeddingClientFactory` supports
**only** Gemini — register a custom `EmbeddingClientFactory` for any other provider. Metadata key
constants: `rag.MetadataSource`, `rag.MetadataSourceURL`, `rag.MetadataHighlights`,
`rag.MetadataUpdatedAt`.

**Security:** route LLM-emitted citations through `wf.rag.validateCitations` before any authoritative
consumer; build the allow-list from the retrieved documents (not the full corpus); wrap retrieved
passages in escaped `<passage source="...">` tags in any prompt (see `rag-common.ts`); pass filter
values to the backend through parameterized queries, never string concatenation.

---

## MCP client ops — `wf.mcp.*`

```ts
const out = wf.mcp.call<In>(input, {
  transport: "http",                 // or "stdio"
  url: "https://…/mcp",              // http: required;  stdio: command + args instead
  tool: "search_docs",
  output: "string",                  // string|number|boolean|string[]|number[]|map|json
  formatArgs: (input) => ({ query: input }),
  initTimeoutMs, callTimeoutMs, maxRetries, headers?, name,
});

const results = wf.mcp.script<In, Out>(input, {
  command: "npx", args: ["-y", "@playwright/mcp@latest"],   // stdio
  script: async (sess, input) => { await sess.callTool("tool_a", {...}); return out; },
  poolSize: 8,                       // stdio-only warm pool; pair with mcp.shutdownMCPPool() at exit
  name,
});
```

`wf.mcp.call` does one tool call per run; `wf.mcp.script` drives many calls over one long-lived session
via a callback receiving an `MCPSession` (`sess.callTool(name, args)` → `{ text, structured }`).
Pooling is **stdio-only**; never set `poolSize` for `transport: "http"`. When any node sets
`poolSize > 0`, the driver MUST call `await mcp.shutdownMCPPool()` in a `finally` to drain pooled
subprocesses. For a per-item MCP fan-out, map the free `mcp.mcpScript(input, opts, ctx)` over an array
node and call `mcp.setupMCPScript(opts)` once at build time (see `local-mcp-server/`). Inside a script,
recover from anticipated tool errors by catching `mcp.MCPToolError`.

---

## Standard program shape

```ts
import { parseArgs } from "node:util";
import { Workflow, ai, ops } from "sparsi-ts";

function build() {
  const wf = new Workflow();
  const text = wf.input<string>("text");
  // … wf.op / wf.ai.* / wf.coalesce / wf.map … returning the nodes the driver reads
  return { wf, /* output nodes */ };
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { text: { type: "string" } } });
  const input = values.text ?? "default";
  const { wf, /* nodes */ } = build();
  const result = await wf.run({ ai: new ai.AnthropicClient(), values: { text: input }, concurrency: 10 });
  console.log(JSON.stringify({ /* result.get(node) … */ }, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
```

Read external input (flags, files, env) in `main()` and pass it through `run({ values })`. Keep
`build()` pure and parameterless where possible. `os`/`process.env` reads belong in `main()`, not in op
bodies (library AI/embedding ops read their keys internally via the client/factory).
