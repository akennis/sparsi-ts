# Core Concepts

Sparsi is built around a few foundational concepts that ensure workflows are deterministic, observable, and concurrent by design.

## The Workflow

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

## Skips: conditional branches that cost nothing

Every node resolves to either a value or the `SKIP` sentinel. **Skips propagate downstream**: an op whose inputs include a skipped producer is itself skipped automatically. `coalesce` is the exception — it skips only when *every* source skipped, which is what makes it the natural join for conditional branches.

```ts
import { SKIP } from "sparsi-ts";

const maybe = wf.op({ x }, ({ x }) => x > 0 ? x : SKIP);
const dependent = wf.op({ maybe }, ({ maybe }) => maybe * 2); // skipped if `maybe` skipped
```

## Conditions and gates

An op can carry a `condition` that decides whether it runs at all. Use `gate` to give the condition access to values that *aren't* passed to the op's body — no identity passthrough node required.

```ts
const cls = wf.ai.modeSelect(ticket, { categories: ["billing", "bug"] });

const bugSteps = wf.ai.extractStringSlice(ticket, {
  operation: "extract the reproduction steps",
  gate: { cls },                                  // visible only to condition
  condition: (_inputs, { cls }) => cls === "bug", // skips unless classified as a bug
});
```
