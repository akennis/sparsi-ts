# Writing Workflows

Building a Sparsi workflow involves wiring together inputs, operators, and AI-backed nodes into a Directed Acyclic Graph (DAG).

## Conditional Logic

Conditional logic in Sparsi is handled via **Skips** and **Coalesce** nodes.

1.  **Skip Propagation:** If a node returns `SKIP`, all nodes that depend on it are also skipped.
2.  **Explicit Conditions:** Every `wf.op` can take a `condition` function. If the condition returns `false`, the op is skipped without running.
3.  **Coalesce:** Use `wf.coalesce` to merge multiple conditional branches. It returns the value of the first branch that didn't skip.

## Mapping and Reducing

Sparsi provides native support for processing arrays of data concurrently.

- `wf.map(arrayNode, (item, ctx) => ...)`: Runs the function for every item in the array node.
- `wf.filter(arrayNode, (item, ctx) => ...)`: Filters the array node based on a predicate.
- `wf.reduce(arrayNode, (acc, item, ctx) => ..., initial)`: Folds the array node.

## AI Operators

AI operators are high-level building blocks for common LLM tasks. Instead of writing raw prompts, use `wf.ai.bool`, `wf.ai.score`, or `wf.ai.modeSelect` to get validated, typed results.

### Reasoning Capture

Enable reasoning capture by passing `reasoning: true` to `wf.run()`. This tells AI operators to request an explanation from the model, which is stored in the `RunResult.reasoning` log.

### AI-Driven Repair

Use `wf.ai.repair` to wrap deterministic logic that might fail due to malformed input. When the inner logic throws `ErrRepairable`, the repair wrapper uses an LLM to "fix" the input based on the provided error message.
