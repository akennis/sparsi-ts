---
name: sparsi-design
description: Design a maximally deterministic sparsi-ts DAG workflow
version: 0.1.0
library_version: sparsi-ts v0.1.0
triggers: [sparsi design, design dag workflow, dag workflow design]
input:
  task: {type: string, description: "Task description", required: true}
---

# Context

You are designing a DAG workflow using the sparsi-ts library. Your goal is a maximally
deterministic design: every step that can be a deterministic `wf.op` (a plain TypeScript
function, optionally using the `ops.*` catalog) MUST be. AI calls are reserved for genuine
natural-language parsing or subjective judgment where no deterministic alternative exists.

**API Key Configuration:** For LLM providers (Claude, Gemini), assume the API keys
(`CLAUDE_API_KEY`, `GEMINI_API_KEY`) are already set. For all other third-party APIs (search
engines, vector stores, etc.), do not assume they are set; instead, explicitly tell the user to
set them as environment variables. In all cases, do not design complex credential-fetching logic
(e.g., Vault, Secret Manager) unless explicitly requested; rely on standard environment-based
lookup (the bundled `ai.EnvAIClientFactory` / `rag.EnvEmbeddingClientFactory`).

# The program is a CLI over a pure workflow

Every generated program is a one-shot CLI tool: it parses flags / reads input in `main()`, runs the
workflow once via `await wf.run({ values })`, and prints the result. Construction of the workflow
(`build()`) is **pure** — nothing executes until `wf.run()`. The design MUST precisely enumerate the
workflow's external inputs (each becomes a `wf.input<T>(key)` node, resolved from `run({ values })`)
and its final outputs (each is a node the driver reads via `result.get(node)`). Capture this in the
`### Run Interface` block of the output, because codegen turns it directly into the CLI's argument
parsing and the `wf.input` / `result.get` wiring.

> This is unrelated to `wf.mcp.call` / `wf.mcp.script`, which make the workflow a *client* of some
> other MCP server. The sparsi-ts library does not expose a generated program *as* an MCP server.

Read the following references before producing any output:
1. `references/library.md` — every op description grouped by category
2. `references/design-rules.md` — design constraints, anti-patterns, and required patterns
3. `references/examples/README.md` — pick the most structurally similar example
4. Read every `.ts` file in that example's directory under `references/examples/<name>/`

Each example is a directory containing one or more `.ts` files. Most examples have just `main.ts`;
the RAG examples split shared prompt/citation helpers into a sibling `rag-common.ts`. Read all `.ts`
files in the chosen example's directory before relying on the pattern.

# Example selection guide

| Workflow pattern | Example |
|---|---|
| Free-form text → fixed categories → per-lane extraction → coalesce | `ticket-triager/` |
| Parse fields + deterministic numeric scoring | `recipe-analyzer/` |
| Parallel HTTP fetch + status-code fallback + multi-probe scoring | `readme-quality/` |
| Parsed data + threshold routing + conditional warning suffix | `weather-advisor/` |
| Runtime array → `wf.map` fan-out → per-item compute → aggregation | `hn-topic-brief/` |
| Two AI models in series — Claude generates, Gemini independently verifies | `faithful-summary/` |
| Strict parse/validate function + AI-driven minimal-mutation retry on bad input (`wf.ai.repair`) | `with-repair/` |
| Retrieval-augmented Q&A — lexical (BM25) retriever, ground an AI answer, parse source citations | `rag-bm25/` |
| Retrieval-augmented Q&A — vector-store retriever (Gemini embeddings + cosine), embedding-factory plumbing | `rag-gemini-embed/` |
| One tool call against a remote (HTTP) MCP server | `remote-mcp-server/` |
| Scripted multi-call MCP session over one long-lived stdio connection + per-item fan-out | `local-mcp-server/` |

# AI recovery wrapper (wf.ai.repair) placement

`wf.ai.repair` is most suitable at the **upstream boundary** of the DAG — wrap the step that first
ingests outside input (user text, fetched payloads, untrusted JSON, third-party API responses) so the
workflow validates and, if necessary, repairs that input before anything downstream depends on it.
Once a value has passed a repair stage, downstream nodes can treat it as well-formed and skip
defensive re-parsing.

`wf.ai.repair` wraps a *deterministic* function (`run`): when that function throws `ai.ErrRepairable`,
the wrapper hands the LLM a self-contained prompt, parses the response back through a codec
(`ai.textCodec()`, `ai.jsonCodec()`, `ai.xmlCodec({...})`), and re-runs — up to `maxAttempts` cycles.
A clean input that parses on the first try makes zero LLM calls.

**Do not** wrap an AI op (`wf.ai.*`) with `wf.ai.repair` to validate its output. AI ops already
self-repair: pass a `validate` callback (on `wf.ai.compute`) that throws to trigger an in-conversation
re-prompt within the same `maxRetries` budget, and write a tight `operation` / `expectedFormat` so the
first response parses. When an AI op is self-validating, the design's **AI Ops Used** entry MUST spell
out the validation rules so codegen can write a precise prompt. Examples:

- `score (wf.ai.score, self-repair: must be a number in [0, 1])` — enforced by the op itself
- `category (wf.ai.modeSelect, categories: [bug, feature, question])` — enforced by the op itself
- `summary (wf.ai.compute, validate: must be wrapped in <summary>…</summary>)`

# Retrieval (RAG) — optional external context fan-in

When the workflow needs facts that are not in the user's input and cannot be hardcoded (knowledge
base, past tickets, current documentation, vector store), fan in retrieved context via
`wf.rag.retrieve`. The node's value is `{ documents: Document[], texts: string[] }`: `documents` are
full records (`{ id, content, score, metadata }`); `texts` is the parallel array of
`documents[i].content` — the convenience wire that plugs directly into AI ops taking `string[]`
(`wf.ai.summarize`, `wf.ai.rerank`/`wf.ai.bestMatch` candidates).

Use `wf.rag.retrieveWithFilters` instead when retrieval needs to be scoped by filter values. Two
channels supply those values, and the op merges them:

- **`filters` input node** (`Record<string,string>`) — for values computed upstream (tenant id from
  auth, category from a classifier, date range from a planner). Optional; omit when there are no
  dynamic filters.
- **`staticFilters` option** — a `Record<string,string>` known at graph-build time (e.g.
  `{ tenant: "acme", locale: "en" }`). Use for filter values fixed for the program's lifetime.

Both compose: the op starts from `staticFilters`, then merges the runtime `filters` on top. **Runtime
values win on key collision.** Decision matrix: no filters → plain `wf.rag.retrieve`; only static →
`retrieveWithFilters` with `staticFilters`; only dynamic → `retrieveWithFilters` with the `filters`
node; mix → set both.

**Filter-value injection — parameterize, never interpolate.** Filter values are stringly-typed and the
Retriever is the only code that interprets them. Inside the Retriever, filter values MUST be passed to
the backend through parameterized queries / placeholder bindings — never string-concatenated into a
SQL `WHERE` clause, a NoSQL query document, or a search-DSL query. Runtime filter values frequently
originate from upstream AI ops (classifier, planner, extractor) whose output is LLM-generated and
therefore untrusted; an attacker who steers that prompt can inject `'; DROP TABLE ...`, `$where`
operators, or vector-store metadata predicates. Designs that name a backend in **Design Rationale**
should call out the parameterization mechanism the Retriever will use.

**Metadata keys.** The library exports named constants for the metadata keys the bundled examples
rely on — use them at codegen time instead of bare string literals: `rag.MetadataSource` (`"source"`),
`rag.MetadataSourceURL` (`"source_url"`), `rag.MetadataHighlights` (`"highlights"`),
`rag.MetadataUpdatedAt` (`"updated_at"`). When the design depends on a specific metadata key, list it
in **Design Rationale** so codegen knows which keys the Retriever must populate.

**Prompt-injection mitigation.** Retrieved passages are *untrusted data* — the corpus may be
attacker-controlled (public KB, user-uploaded docs, crawled pages). A passage prompt-builder MUST wrap
each passage in an XML-style tag (`<passage source="...">...</passage>`), escape the source attribute
and body so a passage cannot close its own tag (use `fast-xml-parser`'s `XMLBuilder`, already a
dependency — see `rag-common.ts`), and instruct the model to treat passage contents as untrusted data,
not instructions. Designs MUST flag this in **Design Rationale** when the corpus is attacker-controlled
or even partially user-supplied.

**Citation re-validation — security rule, not style.** Treat any `sources` list emitted by your
design's citation parser as untrusted: the LLM can hallucinate filenames that were never retrieved,
and a hallucinated citation flowing into a logger, audit record, file reader, or any authoritative
surface is a real security bug (forged provenance, log injection, file-read of attacker-chosen paths).
Any design that parses LLM-emitted citations MUST wire a `wf.rag.validateCitations(raw, allowed)` node
between the parser and any downstream authoritative consumer. The `allowed` allow-list MUST be built
from the **retrieved** documents' source identifiers (not the full loaded corpus, so a model that
hallucinates the filename of a real-but-unretrieved document is still caught). It outputs
`{ accepted, rejected }`: wire `accepted` into the authoritative consumer and warn on `rejected`.

**Embedding credentials (vector-store-backed Retrievers).** Vector-store Retrievers embed the query
before searching. Route embedding credentials through `rag.resolveEmbeddingClient`, not raw env reads
inside the Retriever. **NOTE — gemini asymmetry:** the bundled `rag.EnvEmbeddingClientFactory` only
supports the Gemini provider; for any other embedding provider (Claude, OpenAI, Voyage, Cohere, …) the
design must call out a custom `EmbeddingClientFactory` in **Design Rationale** so codegen registers it
via `rag.registerEmbeddingClientFactory` before `wf.run`. (This is unlike AI ops, whose bundled
factory supports both Claude and Gemini.) The retrieval ops accept optional `credentialRef`,
`clientFactoryId`, `factoryTimeoutMs`, and `embedTimeoutMs` options — include them ONLY when the
Retriever embeds the query; omit them for BM25 / lexical Retrievers and hosted search with its own auth.

The Retriever implementation lives in the generated program (registered via `rag.setDefaultRetriever`
or `rag.registerRetriever`), not in the DAG. The design just names the retrieval node and its wiring.
See `references/examples/rag-bm25/` for an end-to-end RAG workflow with source-file citation
extraction (read both `main.ts` and `rag-common.ts`).

# Per-client credential routing (optional — enterprise)

By default a workflow runs under one AI client (`new ai.AnthropicClient()`), passed as `run({ ai })`.
Any op can override it with the per-op `ai` option (this is how Claude+Gemini mix in one graph — see
`faithful-summary/`). For per-team billing or non-env credential stores, register an `AIClientFactory`
via `ai.setDefaultAIClientFactory` / `ai.registerAIClientFactory`, and resolve clients by `ref` with
`ai.newAIClient({ provider, ref })` (see the `CostCenterFactory` in `ticket-triager/`).

Include credential-routing plumbing in the design **only** when the task explicitly involves
multi-tenant routing, non-env credential sources (Vault, Secrets Manager, KMS, workload identity), or
per-vertex credential rotation. Single-tenant workflows that "just need to call Claude" must NOT
mention it — leave the default client in place. When relevant, name each factory/ref in **Design
Rationale** so codegen emits the matching registration before `wf.run`.

# AI Provider Elicitation

When a workflow requires AI operations, you MUST ask the user for their preferred AI provider and model
if they haven't specified them.

- **Default:** If the user has no preference, the library defaults to Claude, model `claude-sonnet-4-6`
  (`new ai.AnthropicClient()`).
- **Options:** Mention that Gemini (`new ai.GeminiClient()`, default model `gemini-3.1-flash-lite`) is a
  common alternative, and that providers can be mixed per op via the `ai` option.
- **Elicitation:** Ask: "Which AI provider and model would you like to use for the AI steps? (e.g.,
  Claude Sonnet 4.6, Gemini 3.1 Flash Lite)".

Do this before or as part of presenting your initial design.

# Eliciting Missing Data Sources

If the user's task implies the use of external data (files, URLs, MCP tools, databases) but does not
provide specific details (paths, commands, retriever names), you MUST NOT invent placeholders or assume
they should always be runtime inputs.

**CRITICAL: Do NOT hallucinate MCP server details.** If the user mentions an MCP server by name but
does not provide the `url` (for HTTP) or `command` and `args` (for stdio), you MUST ask for them. Do
NOT guess the URL based on the server name.

Instead:
1. Identify the missing data sources.
2. Ask the user for the specifics (file path, MCP command + args, MCP URL, retriever backend).
3. Ask if the source should be a **hardcoded constant** (`wf.constant`, fixed for all runs) or a
   **runtime input** (`wf.input`, different every run).

Do this before or as part of presenting your initial design.

# Steps

1. Read `references/library.md` and identify every op relevant to the task.
2. Read `references/design-rules.md` fully — especially the BRANCHING and SELECTION sections.
3. **Identify missing data sources and AI preferences:** check whether the task needs files, URLs, or
   external tools that aren't specified, and whether AI ops are needed and which provider/model.
4. **Ask for clarification and specify environment needs:** if sources are missing, ask for details
   (and hardcoded vs. runtime); ask for AI provider/model; if using non-LLM APIs, tell the user exactly
   which environment variables they must set.
5. Select the structurally closest example from `references/examples/README.md` and read it.
6. Draft a complete DAG design in the output format below.
7. Present the design. Ask: "Does this design look right? Any changes before I hand it to codegen?"
8. If the user provides feedback, incorporate it and redraft. Repeat until explicit approval.
9. The final approved design is the output — do not proceed to code generation.

# Refinement loop

After presenting a design, wait for user feedback. Refine and re-present. Only mark the design as
approved when the user explicitly says so (e.g. "looks good", "approved", "yes").

# Output format

Respond ONLY with the following structured document. No TypeScript code. No markdown outside this format.

## Workflow: [short name]

### ASCII DAG
[diagram showing nodes and data flow with → arrows; nodes wrapped by `wf.ai.repair` carry a trailing
`[AI:repair]` tag — see "AI-WRAPPED NODES — RENDERER HINT" in `references/design-rules.md`]

### Run Interface
The external boundary of the workflow — codegen turns this into the CLI argument parsing, the
`wf.input(...)` nodes, and the `result.get(...)` reads.

- **Inputs** (one row per external value entering the DAG; each becomes a `wf.input<T>(key)` node):
  - `key` (type, required|optional, hardcoded-constant?|runtime) — description
- **Outputs** (one row per value returned to the caller; each is a node read via `result.get`):
  - `node_name` (type) — description

Every value listed under Inputs MUST appear as a `wf.input` (or `wf.constant`) node in **Nodes**.
Every value under Outputs MUST be a node produced by some entry in **Nodes**.

### Nodes
List each node in topological order:
N. **node_name** — `wf.builder` — [Condition: pred_name] — Options: key=value, ...
   - In: field ← `node_name`
   - Out: `Node<T>`

For map nodes use this format:
N. **node_name** — `wf.map` — item: `item`
   - In: `array_node`
   - Body: per-item description (which ops/sub-steps run on each element)
   - Out: `Node<T[]>`

For repair-wrapped nodes, add a `Wrapper:` line:
N. **node_name** — `wf.ai.repair` — Options: maxAttempts=N, codec=text|json|xml
   - run: the deterministic function it wraps (parse/validate) and what it throws on failure
   - In: input ← `node_name`
   - Out: `Node<T>`

For MCP nodes (`wf.mcp.call`, `wf.mcp.script`), the `transport` option selects how the server is
reached: `transport: "stdio"` (default) requires `command` and accepts optional `args` / `env`;
`transport: "http"` requires `url` and accepts optional `headers`. `poolSize: N` (stdio only) opts a
node into the warm-replenish pool — include it for stdio nodes inside a `wf.map` fan-out or that
otherwise run repeatedly, since subprocess cold-start cost is otherwise paid every run; pair it with
`mcp.shutdownMCPPool()` in the driver's cleanup. `output` selects the built-in result dispatch
("string" | "number" | "boolean" | "string[]" | "number[]" | "map" | "json"); `formatArgs` shapes the
input node into the tool's argument record.

### Conditions / Gates
- `pred_name`: which input/gate node it reads, what value triggers it. Note when a value rides `gate`
  (visible only to the condition, not passed to the op body — no identity passthrough node).

### Custom Ops
For each `wf.op` whose body is non-trivial (not a one-line `ops.*` call):
- **node_name**: inputs (name: type), output type, what the body computes.

### AI Ops Used
For each AI op in the design:
- **node_name** (`wf.ai.<op>`): the exact `operation` / `predicate` / `criterion` / `categories` text —
  phrase it so it unambiguously identifies the task. Pair self-validating ops with their validation
  rules so codegen can write a prompt precise enough that parsing succeeds on the first turn.

### Design Rationale
Key decisions: why certain operations are deterministic vs AI, any tradeoffs.
