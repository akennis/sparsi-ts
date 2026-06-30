<p align="center">
  <img src="sparsi_logo.svg" alt="sparsi-ts logo" width="400">
</p>

[![Node Version](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-BSD_3--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)

# sparsi-ts

**Build AI workflows the way you build software.** sparsi-ts lets you wire deterministic logic and LLM calls into one typed, concurrent DAG — so the parts that *should* be reliable stay reliable, the parts that need a model are isolated and observable, and the whole thing runs in parallel with full TypeScript type inference end to end.

No prompt spaghetti. No orchestration glue. Just typed nodes that compose.

---

## Why sparsi-ts?

- **Deterministic where it counts.** Math, string ops, predicates, JSON extraction, time, and IO are plain, testable functions — not LLM calls. AI is opt-in, node by node.
- **AI as a first-class operator.** `wf.ai.score`, `wf.ai.bool`, and friends take typed input nodes and return typed output nodes. The engine handles the model client and parses/validates the response for you.
- **It's a real DAG.** Nodes declare their dependencies; the engine runs independent branches concurrently and propagates *skips* so conditional branches cost nothing.
- **Typed end to end.** Wiring a node's output into the wrong input is a compile error. `coalesce` returns the *union* of its branch types.
- **Batteries included.** RAG (`wf.rag.*`), MCP tools (`wf.mcp.*`), Anthropic + Gemini clients, retries, and AI-driven repair all ship in the box.

---

## Quick Start

### 1. Install the Library
```bash
npm install sparsi-ts
```

### 2. Install the AI Skills (Optional)
Sparsi provides bundled skills to help you design and generate TypeScript code automatically within your AI assistant. Copy the skills to your assistant's skills folder:

**macOS / Linux:**
```bash
cp -r skills/sparsi-ts-design skills/sparsi-ts-codegen ~/.claude/skills/
```

**Windows (PowerShell):**
```powershell
Copy-Item -Recurse skills/sparsi-ts-design, skills/sparsi-ts-codegen "$env:USERPROFILE\.claude\skills\"
```

### 3. Build a Deterministic Workflow
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

const advice = wf.coalesce([cold, mild, hot]);

const result = await wf.run({ values: { temps: [4, 7, 9, 12, 6, 3, 8] } });
console.log(result.get(advice)); // "Avg 7°C — bundle up."
```

### 4. Add AI
```ts
import { Workflow, ai } from "sparsi-ts";

const wf = new Workflow();
const text = wf.input<string>("text");

const hasPII   = wf.ai.bool(text, { predicate: "does this text contain PII?" });
const keywords = wf.ai.extractStringSlice(text, { operation: "extract the key topics" });
const tldr     = wf.ai.summarize(keywords, { operation: "summarize into one phrase" });

const result = await wf.run({
  ai: new ai.AnthropicClient(),
  values: { text: "…" }
});

console.log(result.get(tldr));
```

---

## Examples

| Example | Demonstrates |
| :--- | :--- |
| [**Temperature**](./examples/temperature.ts) | Deterministic only — conditions, coalesce, map/filter. |
| [**Ticket Triager**](./examples/ticket-triager.ts) | Conditional AI lanes, gates, and typed `coalesce` union. |
| [**Recipe Analyzer**](./examples/recipe-analyzer.ts) | Gemini extractors fan-out, scoring, and gated advice lanes. |
| [**Faithful Summary**](./examples/faithful-summary.ts) | **Mix Claude + Gemini** in one graph for verification. |
| [**HN Topic Brief**](./examples/hn-topic-brief.py) | `map` fan-out over stories and dominant-category compute. |
| [**README Quality**](./examples/readme-quality.ts) | Concurrent quality probes and averaged scoring. |
| [**Smart Doc Assistant**](./examples/rag-bm25.ts) | RAG over a local KB with citation validation. |
| [**Local MCP**](./examples/local-mcp-server.ts) | Local stdio MCP (Playwright) — search + screenshot. |

---

## Documentation

- [**Core Concepts**](./docs/concepts.md) — Workflows, Skips, and Conditions.
- [**Operator Library**](./docs/operators.md) — AI-backed and Deterministic operators.
- [**TypeScript API Reference**](./docs/typescript-api.md) — Workflow and Client APIs.
- [**Writing Workflows**](./docs/writing-workflows.md) — Conditionals, Mapping, and Repair.
- [**RAG & MCP Integration**](./docs/mcp.md) — Retrieval and Tool-calling.
