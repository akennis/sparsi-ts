# Example Index

Each example is a directory under `references/examples/<name>/`. Most contain a single `main.ts`; the
RAG examples split shared prompt/citation helpers into a sibling `rag-common.ts` that `main.ts`
imports. When you pick an example, read **every** `.ts` file in its directory before relying on the
pattern — `main.ts` alone may reference helpers defined in a sibling file.

> **Import-path note.** These reference files import the library via the in-repo relative path
> (`from "../src"`, and in two cases a submodule: `ErrRepairable` from `../src/ai`, the
> `MCPScriptCallback` type from `../src/mcp`). **Generated code must instead import from the installed
> package** — `import { Workflow, ai, ops, rag, mcp } from "sparsi-ts"`. Symbols the examples import
> from a submodule are reached through the namespace export: `ai.ErrRepairable` (value),
> `mcp.MCPScriptCallback` (type). Read the examples for the *idioms*, not the import lines.

Read the example whose structural pattern most closely matches the workflow you are designing.

| Structural pattern | Example directory |
|---|---|
| Multi-lane text classification (free-form input → category → per-lane extraction → coalesce union) | `ticket-triager/` |
| Extraction pipeline + deterministic numeric scoring (parse fields → hardcoded scoring → format) | `recipe-analyzer/` |
| Parallel HTTP fetch + status-code fallback + multi-probe scoring (dual GET → select → AI probes) | `readme-quality/` |
| Data parsing + band routing + conditional warning probe (parse → threshold lanes → coalesce + ternary suffix) | `weather-advisor/` |
| `wf.map` fan-out + aggregation + routing (array → per-item compute → collect → summarize) | `hn-topic-brief/` |
| Cross-model verification (Claude generates, Gemini independently checks faithfulness) | `faithful-summary/` |
| AI-driven repair around deterministic ops (`wf.ai.repair` with a text codec and an XML-struct codec) | `with-repair/` |
| RAG over a local KB with a lexical BM25 retriever + source-file citations + citation validation | `rag-bm25/` |
| RAG with a vector-store retriever (Gemini embeddings + cosine), embedding-factory credential plumbing | `rag-gemini-embed/` |
| Single tool call against a remote (HTTP) MCP server | `remote-mcp-server/` |
| Scripted multi-call MCP session over one long-lived stdio connection + per-item screenshot fan-out (pooled) | `local-mcp-server/` |

## Quick-reference guidance

- **Free-form text → fixed categories → per-lane work**: use `ticket-triager`. `wf.ai.modeSelect`
  classifies; per-lane `wf.ai.extractMap` / `wf.ai.parseNumber` / `wf.ai.score` run only in the
  matching lane (gated via `condition` + `gate`); `wf.coalesce` merges and returns the typed union of
  the per-lane brief shapes.

- **Extract structured fields + score them deterministically**: use `recipe-analyzer`. AI extractors
  produce the fields; deterministic `ops.num` scoring computes the final score — no AI in the scoring
  path.

- **Two competing data sources, pick the better one**: use `readme-quality`. Both `ops.io.httpGet`
  calls run in parallel; a ternary on the status code picks the 200 body; multiple `wf.ai.score` /
  `wf.ai.bool` probes score the result independently.

- **Numeric threshold routing + optional warning**: use `weather-advisor`. Mutually exclusive lanes
  gated on a parsed number, merged by `wf.coalesce`; an orthogonal `wf.ai.bool` probe appends a
  warning suffix via a ternary in a final `wf.op`.

- **Runtime-length list of items, each needing the same pipeline**: use `hn-topic-brief`. `wf.map`
  fans out over the fetched items; a per-item function runs deterministic + AI steps; the collected
  array feeds `wf.ai.summarize`.

- **Two AI models in series for cross-model verification**: use `faithful-summary`. Claude writes a
  summary via `wf.ai.compute`; a deterministic `wf.op` formats source + summary into a verification
  prompt; `wf.ai.bool` with a per-op `ai: new ai.GeminiClient()` checks faithfulness. Use this when the
  generating model should not also judge its own output.

- **Self-healing parse/validate around bad input**: use `with-repair`. `wf.ai.repair` wraps a
  deterministic parse/validate function that throws `ai.ErrRepairable`; the wrapper repairs the input
  via the LLM (`ai.textCodec()` for string targets, `ai.xmlCodec({...})` for struct targets) and
  re-runs. Clean input makes zero LLM calls.

- **Retrieval-augmented generation over a local KB**: use `rag-bm25`. Register a `rag.Retriever`
  (`rag.setDefaultRetriever`); `wf.rag.retrieve` pulls top-k; a `wf.op` builds an injection-safe prompt
  (XML-wrapped passages); `wf.ai.compute` answers; a parser splits out cited sources; and
  `wf.rag.validateCitations` drops hallucinated citations against the retrieved allow-list. Read both
  `main.ts` and `rag-common.ts`.

- **RAG with a vector-store retriever**: use `rag-gemini-embed`. Same shape as `rag-bm25` but the
  Retriever embeds the query via `rag.resolveEmbeddingClient` (Gemini) and ranks by cosine similarity,
  demonstrating embedding-factory credential routing. Swap the in-memory cosine for pgvector / Pinecone
  / Weaviate without changing the routing code.

- **Calling a remote (HTTP) MCP server**: use `remote-mcp-server`. `wf.mcp.call` with
  `transport: "http"`, `url`, `tool`, `output`, and a `formatArgs` that shapes the input node into the
  tool's argument record. Optional `headers` for authenticated servers. Pooling is stdio-only — do not
  set `poolSize` for http transport.

- **Driving an MCP server through multiple tool calls in one DAG step**: use `local-mcp-server`.
  `wf.mcp.script` drives a callback that issues many `sess.callTool(...)` calls over one long-lived
  session. The per-URL screenshot fan-out maps the free `mcp.mcpScript` over an array node with
  `poolSize` set; the driver calls `mcp.shutdownMCPPool()` in a `finally` to drain pooled subprocesses.
