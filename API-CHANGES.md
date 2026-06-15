# API-CHANGES — the spec downstream sessions read instead of cold-reading `src/`

Each entry: the finding it resolves, the new signature, and one before/after
snippet. Downstream sessions (Phase 2/3) should treat these signatures as fixed.

---

## Phase 1

### S1 · Engine/Workflow API — DONE

Six additive, backward-compatible changes to `src/{types,workflow,engine,context}.ts`.
Existing call sites keep compiling; the new shapes are opt-in.

---

#### S1.1 — `RunResult` node introspection (Finding E)

No more hand-maintained parallel label arrays cross-referenced with
`result.skipped(node)`. The result enumerates its own nodes.

```ts
interface NodeStatus {
  readonly id: string;
  readonly name: string;
  readonly kind: string;     // "op" | "map" | "coalesce" | "zip" | ...
  readonly skipped: boolean;
  readonly value?: unknown;  // present iff !skipped
}
interface RunResult {
  // ...existing get/getOr/skipped/reasoning...
  nodes(): NodeStatus[];      // every node, in graph (insertion) order
  firedNodes(): NodeStatus[]; // just the non-skipped nodes
}
```
`NodeStatus` is exported from the package root.

```ts
// BEFORE — parallel array duplicating node names, cross-referenced by hand
const aiCandidates = [["AIComputeStringToStringOp(easy.advice)", easyNode], ...] as const;
const fired = aiCandidates.filter(([, node]) => !result.skipped(node)).map(([label]) => label);

// AFTER
const fired = result.firedNodes().map((n) => n.name);
```

---

#### S1.2 — `coalesce` returns a union (Finding F)

```ts
coalesce<S extends readonly Node<any>[]>(sources: S, opts?: OpOptions):
  Node<NodeValue<S[number]>>   // union of branch value types
```
Runtime unchanged (still first non-skipped wins; skips only when all skip).
Purely a type-level widening, so branches of different shapes no longer collapse
to a common type.

```ts
// BEFORE — branches flattened to JSON strings to unify as Node<string>, reparsed downstream
const billingBrief = wf.op({...}, () => JSON.stringify({...}));   // Node<string>
const bugBrief     = wf.op({...}, () => JSON.stringify({...}));   // Node<string>
const merged = wf.coalesce([billingBrief, bugBrief]);            // Node<string>
const obj = JSON.parse(result.get(merged)) as Record<string, unknown>;

// AFTER — branches keep their shapes
const billingBrief = wf.op({...}, () => ({ kind: "billing", ... } as const)); // Node<Billing>
const bugBrief     = wf.op({...}, () => ({ kind: "bug", ... } as const));     // Node<Bug>
const merged = wf.coalesce([billingBrief, bugBrief]);                         // Node<Billing | Bug>
```

---

#### S1.3 — `condition` reads `gate` nodes the op body doesn't (Finding G)

`op` gains a third type param `G` and `opts.gate`; `Condition` gains a second
positional arg. Gate nodes are dependencies (a skipped gate skips the op) but are
**not** passed to `fn`. Removes identity "gate" passthrough ops.

```ts
type Condition<D extends NodeMap, G extends NodeMap = {}> =
  (inputs: Resolved<D>, gate: Resolved<G>, ctx: RunContext) => boolean | Promise<boolean>;

interface OpDefOptions<D extends NodeMap, G extends NodeMap = {}> extends OpOptions {
  gate?: G;
  condition?: Condition<D, G>;
}
op<D extends NodeMap, O, G extends NodeMap = {}>(inputs: D, fn: OpFn<D, O>, opts?: OpDefOptions<D, G>): Node<O>
```
Existing one-arg conditions `({ x }) => ...` still typecheck (extra params ignored).

```ts
// BEFORE — identity op wires `cls` only so the condition can see it; body uses only `ticket`
const gateBilling = wf.op({ cls, ticket }, ({ ticket }) => ticket,
  { name: "gate_billing", condition: ({ cls }) => cls === "billing" });
const billing = wf.op({ ticket: gateBilling }, ({ ticket }) => makeBrief(ticket));

// AFTER — no passthrough; gate carries `cls` to the predicate only
const billing = wf.op({ ticket }, ({ ticket }) => makeBrief(ticket),
  { name: "billing", gate: { cls }, condition: (_in, { cls }) => cls === "billing" });
```

---

#### S1.4 — `wf.zip` correlated tuples (Finding H)

```ts
zip<S extends readonly Node<readonly unknown[]>[]>(sources: [...S], opts?: OpOptions):
  Node<{ [K in keyof S]: ElementOf<S[K]> }[]>   // array of typed tuples, truncated to shortest
```
Skips if any source skipped.

```ts
// BEFORE — positional zip with casts + manual length guard
const n = Math.min(titles.length, flags.length, labelLists.length);
for (let i = 0; i < n; i++) {
  const title = titles[i] as string;
  const labels = labelLists[i] as string[];
  // ...
}

// AFTER
const rows = wf.zip([titles, flags, labels]);            // Node<[string, boolean, string[]][]>
const briefs = wf.map(rows, ([title, flag, labels]) => /* typed, no casts */);
```

---

#### S1.5 — `wf.source` dependency-free producer (Finding L)

```ts
source<O>(fn: (ctx: RunContext) => O | Skip | Promise<O | Skip>, opts?: OpDefOptions<{}>): Node<O>
```
Thin wrapper over `op({}, ...)`.

```ts
// BEFORE
wf.op({}, (_in: Record<string, never>, ctx) => runExample(ctx), { name: "run" });
// AFTER
wf.source((ctx) => runExample(ctx), { name: "run" });
```

---

#### S1.6 — per-op `ai` option (engine-side of Finding B)

`OpOptions` gains `ai?: AIClient`. The engine runs that op's condition and body
under a context whose `ctx.ai` is swapped (via library-owned `withAI(ctx, ai)` in
`context.ts`). **Phase 2 (S2) consumes this** so AI ops stop reconstructing
`RunContext` by hand.

```ts
interface OpOptions {
  name?: string;
  onError?: "stop" | "continue";
  ai?: AIClient;   // overrides RunOptions.ai for this op only
}
```

```ts
// BEFORE — user rebuilds the engine-owned context to redirect one op
const withCostCenter = (ctx, cc) => ({ ...ctx, ai: ai.newAIClient(...) });
wf.op({ ticket }, ({ ticket }, ctx) => ai.modeSelect(ticket, opts, withCostCenter(ctx, "triage")));

// AFTER (mechanism; S2 wires it into the AI node constructors)
wf.op({ ticket }, ({ ticket }, ctx) => /* ctx.ai is already the per-op client */, { ai: triageClient });
```

`withAI(ctx, ai)` is exported from `src/context.ts` for the AI/RAG/MCP layers to
reuse if they need to derive a client-swapped context internally.

---

### S2 · AI op surface — DONE

Additive, backward-compatible changes to `src/ai/{ops,compute,graph,index}.ts`.
The free `(value, opts, ctx)` functions are unchanged and still exported (they
are the implementation the node constructors wrap); the new node surface is
opt-in. **S4a/S4b mirror this `wf.<ns>` pattern for RAG/MCP.**

---

#### S2.1 — AI ops as `wf.ai.*` node constructors (Findings A, D)

AI ops are now node constructors on a `wf.ai` namespace: they take input *nodes*
and return an output *node*, exactly like `wf.map`/`wf.filter`. The engine
supplies `ctx`; the input is declared once; there is one `name`.

Layering is preserved: `src/ai/graph.ts` augments `Workflow.prototype` with the
`ai` accessor (declaration-merged onto `Workflow`), so core `workflow.ts` never
imports the AI SDKs. The accessor is live once the `ai` package is imported
(which using any AI op already requires); `wf.ai` is memoized per workflow.

```ts
// Common node options (node wiring + AI-call config).
interface AINodeOptions {
  maxRetries?: number;        // AI-call retries (default 3)
  model?: string;             // per-op model override
  name?: string;              // node name AND reasoning label (single name)
  ai?: AIClient;              // per-op client (see S2.4)
  onError?: "stop" | "continue";
}

interface Workflow {          // installed by importing `ai`
  readonly ai: AINamespace;
}
```

`AINamespace` methods (each returns a `Node`):

```ts
modeSelect(input: Node<string>, opts: AINodeOptions & { categories: string[] }): Node<string>
bool(input: Node<string>, opts: AINodeOptions & { predicate: string }): Node<boolean>
score(input: Node<string>, opts: AINodeOptions & { criterion: string }): Node<number>
classifyMultiLabel(input: Node<string>, opts: AINodeOptions & { categories: string[] }): Node<string[]>
bestMatch(query: Node<string>, candidates: Node<string[]>, opts?: AINodeOptions): Node<number>
rerank(query: Node<string>, candidates: Node<string[]>, opts?: AINodeOptions): Node<number[]>
summarize(items: Node<string[]>, opts: AINodeOptions & { operation: string }): Node<string>
extractStringSlice(input: Node<string>, opts: AINodeOptions & { operation: string }): Node<string[]>
extractMap(input: Node<string>, opts: AINodeOptions & { operation: string }): Node<Record<string,string>>
parseNumber(input: Node<string>, opts?: AINodeOptions & { operation?: string }): Node<number>
compute<K extends OutputKind>(input: Node<unknown>, opts: AIComputeNodeOptions<K>): Node<AIComputeResult<K>>
```

```ts
// BEFORE — re-wrap in wf.op, declare `ticket` twice, courier ctx, name twice
const cls = wf.op({ ticket }, ({ ticket }, ctx) =>
  ai.modeSelect(ticket, { categories: CATEGORIES }, ctx), { name: "classify" });

// AFTER — node in, node out; engine supplies ctx; one name
const cls = wf.ai.modeSelect(ticket, { categories: CATEGORIES, name: "classify" });
```

A skipped input skips the AI node automatically (it is a normal `wf.op`); no
special-casing needed.

---

#### S2.2 — `compute` output type inferred from the kind (Finding C)

`AIComputeResult<K>` maps an `OutputKind` to its parsed value type, so the shape
is stated **once** (as `output`) instead of also as a `<O>` type parameter that
can silently disagree.

```ts
type AIComputeResult<K extends OutputKind> =
  K extends "string" ? string : K extends "number" ? number :
  K extends "boolean" ? boolean : K extends "string[]" ? string[] :
  K extends "number[]" ? number[] : K extends "map" ? Record<string,string> : never;
```

```ts
// BEFORE — shape stated twice; <string> and "string" can drift
ai.aiCompute<string>(meal, { operation: OP, output: "string", name: "advice" }, ctx)

// AFTER — Node<string>, inferred from output
wf.ai.compute(meal, { operation: OP, output: "string", name: "advice" })
```

The free `aiCompute<Out>(...)` is unchanged for existing callers; the inference
lives on the `wf.ai.compute` surface (and `AIComputeResult` is exported).

---

#### S2.3 — Single `name` on the free ops (Finding D)

`AIOpOptions` gained `name?: string`, threaded into each op's reasoning-record
label and exhaustion error. The `wf.ai.*` constructors forward the node's name
here, so a value is named once (node name == AI-op label == reasoning `node`),
not once for the node and once for the inner AI op.

---

#### S2.4 — Per-op client via `opts.ai` (resolution side of Finding B)

The node constructors forward `opts.ai` to S1's `OpOptions.ai`, so the engine
runs that op under the chosen client (via `withAI`). User code never
reconstructs `RunContext` to redirect one op.

```ts
// BEFORE — rebuild the engine-owned context per AI op
const withCostCenter = (ctx, cc) => ({ ...ctx, ai: ai.newAIClient(...) });
wf.op({ ticket }, ({ ticket }, ctx) => ai.modeSelect(ticket, opts, withCostCenter(ctx, "triage")));

// AFTER
wf.ai.modeSelect(ticket, { categories: CATEGORIES, ai: triageClient, name: "classify" });
```

Spec verified by `test/ai-s2.test.ts` (+7 tests; 237/237 pass).

---

#### S2.5 — `gate`/`condition` on `wf.ai.*` (Finding G, AI layer) — added in S5a

Conditional AI ops (e.g. a difficulty-gated advice lane) had no node-constructor
expression: `AINodeOptions` carried no `gate`/`condition`, so callers fell back to
a hand-wired `wf.op` that threaded the gating value through the op's *data inputs*
purely so the predicate could see it (the body ignored it) — the Finding-**G**
gate smell, one layer up. Every `wf.ai.*` constructor now accepts the S1.3
`gate`/`condition` pair, so a gated AI node stays first-class.

```ts
interface AIGateOptions<D extends NodeMap, G extends NodeMap = {}> {
  gate?: G;                       // nodes the predicate reads; NOT passed to the AI call
  condition?: Condition<D, G>;    // (aiInputs, gate, ctx) => boolean
}
// every constructor gains `<G extends NodeMap = {}>` and intersects its opts with
// AIGateOptions<{ <internal input map> }, G>; `wiring()` forwards gate/condition
// to the underlying wf.op. A skipped gate skips the node (gate is a dependency).
```

```ts
// BEFORE — wf.op wrapper; difficultyScore wired into data inputs only for the gate
const easyAdvice = wf.op(
  { difficultyScore, mealName },
  ({ mealName }, ctx) => ai.aiCompute<string>(mealName, { operation: OP_EASY, output: "string", name: "easy_advice", model: MODEL }, ctx),
  { name: "easy_advice", condition: ({ difficultyScore }) => difficultyScore < EASY_MAX });

// AFTER — first-class gated AI node; gate carries the score, AI input is just the meal
const easyAdvice = wf.ai.compute(mealName, {
  operation: OP_EASY, output: "string", name: "easy_advice",
  gate: { difficultyScore },
  condition: (_in, { difficultyScore }) => difficultyScore < EASY_MAX,
});
```

Additive/backward-compatible (default `G = {}`; existing ungated calls unchanged).
Verified by `test/ai-s2.test.ts` (+2 gated-compute tests; 260/260 pass).

---

#### S2.6 — per-node transient-retry via `opts.retry` (added in S5a)

`AINodeOptions.maxRetries` only re-prompts on *parse/validation* failures; a
transient **provider** error (5xx / 429 / "overloaded" / "high demand") thrown by
`ai.call()` propagated immediately, with no backoff. The library already shipped
`withRetry(client, cfg)` (exponential backoff + jitter, gated by
`isTransientError`) but only as a run-level client wrapper. `AINodeOptions` now
exposes it per node:

```ts
interface AINodeOptions {
  // ...maxRetries (parse retries) / model / name / ai / onError...
  retry?: boolean | RetryConfig;   // backoff on transient PROVIDER errors, this op only
}
interface RetryConfig { maxRetries?: number; initialDelayMs?: number; } // from ../src/ai
```

When set, the constructor runs the op body under a context whose client is
`withRetry(<effective client>, cfg)` — the *effective* client being the per-op
`ai` (if given) else the run-wide client, since the engine has already swapped
`ctx.ai` by body time. `true` uses defaults; a `RetryConfig` tunes the budget.
Off by default; orthogonal to `maxRetries` (parse) and composes with `gate`/`ai`.

```ts
// per-node: only this slow op backs off
const advice = wf.ai.compute(meal, {
  operation: OP, output: "string", name: "advice",
  retry: { maxRetries: 4, initialDelayMs: 500 },
});

// run-wide (no source change): wrap the client once — what the S5a examples do
const result = await wf.run({ ai: ai.withRetry(new ai.GeminiClient({ model: MODEL })) });
```

Verified by `test/ai-s2.test.ts` (+2 tests: retries a 503 then succeeds; leaves a
non-transient 400 un-retried; 262/262 pass).

---

## Phase 2

### S3 · Repair seam — DONE

`withRepair`'s raw `string` wire boundary is replaced by a structured codec seam
in `src/ai/repair.ts`. The library now owns serialization, parsing, XML escaping,
and code-fence stripping, so consumers stop hand-rolling those. **Breaking:**
`WithRepairConfig.parse` is removed in favor of `codec` (the only consumers were
`examples/with-repair.ts` and the repair/reasoning tests, all migrated).

---

#### S3.1 — `RepairCodec<T>` + built-in codecs (Finding J)

```ts
interface RepairCodec<T> {
  encode(value: T): string;     // value → wire text embedded in a repair prompt
  decode(response: string): T;  // LLM response → value (owns fence-stripping); throw ⇒ unparseable
}

function textCodec(): RepairCodec<string>;                         // identity encode; decode strips fences
function jsonCodec<T = unknown>(opts?: { indent?: number }): RepairCodec<T>;
function xmlCodec<T = Record<string, string>>(spec: XMLCodecSpec): RepairCodec<T>;

interface XMLCodecSpec {
  root: string;                 // root element name
  fields: readonly string[];    // child element names, in serialization order (string fields)
  optional?: readonly string[]; // subset of `fields` omitted when empty/absent
}
```

`xmlCodec` renders `<root>\n  <field>escaped</field>…\n</root>` (escaping element
text, omitting empty optionals) and decodes by per-tag extraction (unescape +
trim, omitting absent optionals); `decode` throws when the root element is
missing. `RepairCodec`, `XMLCodecSpec`, `textCodec`, `jsonCodec`, `xmlCodec` are
exported from `../src/ai`.

---

#### S3.2 — `WithRepairConfig.parse` → `codec`

```ts
interface WithRepairConfig<T, O> {
  run: (input: T, ctx: RunContext) => O | Promise<O>;
  codec: RepairCodec<T>;   // replaces `parse: (response: string) => T`
  // ...maxAttempts / promptPrefix / promptSuffix / model / maxTokens / name unchanged...
}
```

`withRepair` calls `cfg.codec.decode(res.text)` where it used to call
`cfg.parse(res.text)`; a `decode` throw still consumes the attempt and augments
the next prompt (unchanged semantics).

```ts
// BEFORE — hand-rolled XML serializer + parser + escaper + fence-stripper in the example
function renderTicketXML(t) { let xml = "<ticket>\n"; xml += `  <id>${escapeXmlText(t.id)}</id>\n`; ... }
function parseTicketXML(r) { const cleaned = stripCodeFences(r); /* regex-per-tag + xmlUnescape */ }
wf.op({ ticket }, ({ ticket }, ctx) => ai.withRepair(ticket, {
  run: (t) => validateRouting(t),
  parse: (response) => parseTicketXML(response),
  ...
}, ctx));

// AFTER — one codec describes the wire format; library owns the plumbing
const ticketCodec = ai.xmlCodec<TicketInput>({
  root: "ticket",
  fields: ["id", "priority", "reporter_email", "summary", "escalation_contact"],
  optional: ["escalation_contact"],
});
// prompt rendering: `ticketCodec.encode(t)`; parsing: the codec itself
wf.op({ ticket }, ({ ticket }, ctx) => ai.withRepair(ticket, {
  run: (t) => validateRouting(t),
  codec: ticketCodec,
  ...
}, ctx));
```

`examples/with-repair.ts` deletes `renderTicketXML`, `parseTicketXML`,
`xmlUnescape`, `stripCodeFences`, and its `escapeXmlText` import; the raw-string
stage-1 uses `ai.textCodec()`. Hygiene (M) folded in: hand-rolled `parseArgs` loop
→ `node:util` `parseArgs`. `rag-common.ts`'s XML escapers are untouched (still used
by `buildRagPrompt`; that path is S6's scope).

Spec verified by `test/repair.test.ts` (+7 codec tests) and the migrated
reasoning test; 244/244 pass. `npm run example:repair` still runs offline on the
clean fixture.

---

### S4a · RAG op surface — DONE

Additive, backward-compatible changes to `src/rag/{graph(new),index}.ts`. Mirrors
S2's `wf.<ns>` node-constructor pattern for the retrieval ops, so RAG calls stop
re-wrapping the free `(value, opts, ctx)` functions in `wf.op`. The free
functions (`retrieve`, `retrieveWithFilters`, `validateCitations`) are unchanged
and still exported (they are the implementation the constructors wrap); the new
node surface is opt-in. **S4b mirrors this same pattern for MCP.**

---

#### S4a.1 — RAG ops as `wf.rag.*` node constructors (Finding A, RAG tail)

Retrieval ops are now node constructors on a `wf.rag` namespace: they take input
*nodes* and return an output *node*, exactly like `wf.ai.*`/`wf.map`. The engine
supplies `ctx`; the input is declared once; there is one `name`.

Layering matches S2: `src/rag/graph.ts` augments `Workflow.prototype` with the
`rag` accessor (declaration-merged onto `Workflow`), so core `workflow.ts` never
imports the RAG surface. The accessor is live once the `rag` package is imported
(which using any retrieval op already requires); `wf.rag` is memoized per
workflow. Retrieval ops resolve a Retriever from the registry (not an AI client),
so `RAGNodeOptions` has **no** per-op `ai` field — only `name`/`onError` node
wiring, merged with the existing `RetrieveOptions`/`RetrieveWithFiltersOptions`.

```ts
interface RAGNodeOptions { name?: string; onError?: "stop" | "continue"; }
interface RAGRetrieveNodeOptions extends RAGNodeOptions, RetrieveOptions {}
interface RAGRetrieveWithFiltersNodeOptions
  extends RAGNodeOptions, RetrieveWithFiltersOptions {}

interface Workflow {              // installed by importing `rag`
  readonly rag: RAGNamespace;
}
```

`RAGNamespace` methods (each returns a `Node`):

```ts
retrieve(input: Node<string>, opts?: RAGRetrieveNodeOptions): Node<RetrieveResult>
retrieveWithFilters(
  input: Node<string>,
  filters?: Node<Record<string, string> | null | undefined>,  // optional 2nd node arg
  opts?: RAGRetrieveWithFiltersNodeOptions,
): Node<RetrieveResult>
validateCitations(
  raw: Node<readonly string[] | null | undefined>,
  allowed: Node<readonly string[] | null | undefined>,
  opts?: RAGNodeOptions,
): Node<CitationResult>
```

```ts
// BEFORE — re-wrap in wf.op, declare `query` twice, courier ctx, name twice
const docs = wf.op({ query }, ({ query }, ctx) =>
  rag.retrieve(query, { k: 5 }, ctx), { name: "retrieve" });

// AFTER — node in, node out; engine supplies ctx; one name
const docs = wf.rag.retrieve(query, { k: 5, name: "retrieve" });
```

The runtime-filters argument is an **optional second node**: supply it to wire
upstream filter values (it becomes a real dependency — a skipped filters node
skips retrieval, runtime filters win on key collision with `staticFilters`);
omit it (`undefined`) for static-only filtering. `validateCitations` is pure
(no `ctx`). A skipped input skips the node automatically (it is a normal
`wf.op`); no special-casing.

```ts
// runtime + static filters
const docs = wf.rag.retrieveWithFilters(query, filtersNode, { staticFilters });
// static-only
const docs = wf.rag.retrieveWithFilters(query, undefined, { staticFilters });
// security citation filter, composing like any other node
const cites = wf.rag.validateCitations(rawCites, allowed);   // Node<CitationResult>
```

`RAGNamespace`, `RAGNodeOptions`, `RAGRetrieveNodeOptions`, and
`RAGRetrieveWithFiltersNodeOptions` are exported from `../src/rag`.

Spec verified by `test/rag-s4a.test.ts` (+7 tests; 251/251 pass).

---

### S4b · MCP op surface — DONE

Additive, backward-compatible changes to `src/mcp/{graph(new),index}.ts`. Mirrors
S2/S4a's `wf.<ns>` node-constructor pattern for the MCP ops, so MCP calls stop
re-wrapping the free `(value, opts, ctx)` functions in `wf.op`. The free
functions (`mcpCall`, `mcpScript`) and their `setupMCP*` halves are unchanged and
still exported (they are the implementation the constructors wrap); the new node
surface is opt-in.

---

#### S4b.1 — MCP ops as `wf.mcp.*` node constructors (Finding A, MCP tail)

MCP ops are now node constructors on a `wf.mcp` namespace: they take an input
*node* and return an output *node*, exactly like `wf.ai.*`/`wf.rag.*`/`wf.map`.
The engine supplies `ctx`; the input is declared once; there is one `name`. MCP
ops resolve a session from the transport/pool (not an AI client), so
`MCPNodeOptions` has **no** per-op `ai` field — only `name`/`onError` node
wiring, merged with the existing `MCPCallOptions`/`MCPScriptOptions`.

Layering matches S2/S4a: `src/mcp/graph.ts` augments `Workflow.prototype` with the
`mcp` accessor (declaration-merged onto `Workflow`), so core `workflow.ts` never
imports the MCP surface. The accessor is live once the `mcp` package is imported
(which using any MCP op already requires); `wf.mcp` is memoized per workflow.

**Setup is folded into construction.** Unlike AI/RAG, MCP ops have a two-phase
shape: a build-time `setupMCP*(opts)` (validate + prewarm the stdio pool) plus a
per-run `mcpCall`/`mcpScript` that never prewarms. The constructor runs at build
time, so it owns the `setupMCP*` call — build-time work (validation + pool
prewarm) now happens where it belongs and can no longer be forgotten. The op body
it registers calls the bare per-run function.

```ts
interface MCPNodeOptions { name?: string; onError?: "stop" | "continue"; }
interface MCPCallNodeOptions<In, Out> extends MCPCallOptions<In, Out>, MCPNodeOptions {}
interface MCPScriptNodeOptions<In, Out> extends MCPScriptOptions<In, Out>, MCPNodeOptions {}

interface Workflow {              // installed by importing `mcp`
  readonly mcp: MCPNamespace;
}
```

`MCPNamespace` methods (each returns a `Node`):

```ts
// no parseResponse → Out inferred from the output kind (default "string")
call<In, K extends MCPOutputKind = "string">(
  input: Node<In>, opts: …& { output?: K },
): Node<MCPCallNodeResult<K>>
// parseResponse hook → Out from the hook, output kind ignored
call<In, Out>(
  input: Node<In>, opts: …& { parseResponse: (text, structured) => Out },
): Node<Out>
script<In, Out>(input: Node<In>, opts: MCPScriptNodeOptions<In, Out>): Node<Out>
```

```ts
// BEFORE — manual setup (often forgotten), re-wrap in wf.op, declare input twice, courier ctx, name twice
mcp.setupMCPCall(opts);
const out = wf.op({ query }, ({ query }, ctx) =>
  mcp.mcpCall<SearchInput, string>({ query }, opts, ctx), { name: "cf_search" });

// AFTER — constructor owns setup+prewarm at build time; node in, node out; one name
const out = wf.mcp.call(query, { ...opts, name: "cf_search" });   // Node<string>, inferred from output:"string"
```

#### S4b.2 — `call` output type inferred from the kind (Finding C, MCP tail)

`MCPCallNodeResult<K>` maps an `MCPOutputKind` to its parsed value type, so the
shape is stated **once** (as `output`) instead of also as the `<Out>` type
parameter that can silently disagree. `"json"` has no fixed target shape, so it
widens to `unknown`; the rest reuse the AI compute map.

```ts
type MCPCallNodeResult<K extends MCPOutputKind> =
  K extends "json" ? unknown : K extends OutputKind ? AIComputeResult<K> : never;
```

A `parseResponse` hook (full control over parsing) overrides this to its own
return type via an overload. A skipped input skips the node automatically (it is a
normal `wf.op`); no special-casing.

`MCPNamespace`, `MCPNodeOptions`, `MCPCallNodeOptions`, `MCPScriptNodeOptions`,
and `MCPCallNodeResult` are exported from `../src/mcp`.

Spec verified by `test/mcp-s4b.test.ts` (+7 tests; 258/258 pass).
