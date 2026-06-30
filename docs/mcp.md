# Integration: RAG & MCP

Sparsi provides first-class support for Retrieval-Augmented Generation (RAG) and the Model Context Protocol (MCP).

## Retrieval-Augmented Generation (`wf.rag.*`)

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

## Model Context Protocol (`wf.mcp.*`)

Call MCP tools — over stdio (subprocess) or streamable HTTP — as graph nodes.

### Calling MCP Tools

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

### Exposing Workflows as MCP Servers

You can also expose a Sparsi workflow as an MCP tool using the `MCPServer` class:

```ts
import { Workflow, mcp } from "sparsi-ts";

const wf = new Workflow();
// ... define workflow ...

const server = new mcp.MCPServer("my-sparsi-server", "1.0.0");
server.addWorkflowTool("my_tool", {
  description: "Does something smart with Sparsi",
  workflow: wf,
  inputMapping: { "query": "workflow_input_key" },
  outputWire: "final_result"
});

await server.run(); // Runs on stdio
```
