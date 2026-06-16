# TypeScript API Reference

This document provides a detailed reference for the `sparsi-ts` API.

## Workflow Building

### `new Workflow()`
Initializes a new graph builder.

### `wf.run(options)`
Executes the workflow.
- `ai`: Default `AIClient`.
- `values`: Input value map.
- `concurrency`: Max parallel ops.
- `reasoning`: Enable reasoning capture.
- `signal`: `AbortSignal` for cancellation.

## AI Clients

```ts
import { ai } from "sparsi-ts";

new ai.AnthropicClient({ apiKey?, model? });
new ai.GeminiClient({ apiKey?, model? });
new ai.MockAIClient(handler);
```

## Run Results

The `RunResult` object returned by `wf.run()`:
- `get(node)`: Returns the value or throws if skipped.
- `getOr(node, fallback)`: Returns the value or fallback.
- `skipped(node)`: Returns true if the node skipped.
- `nodes()`: Returns all `NodeStatus` entries.
- `reasoning`: Returns all `ReasoningEntry` records.

## Internal Structure

The codebase is layered for tree-shakeability and clear separation of concerns:
- `src/workflow.ts`, `engine.ts`, `types.ts`: Pure DAG core.
- `src/ops/`: Deterministic operators.
- `src/ai/`: AI ops + provider clients.
- `src/rag/`: Retrieval ops and interfaces.
- `src/mcp/`: MCP transport and tool calling.
