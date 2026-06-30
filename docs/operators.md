# Operator Library

Sparsi provides a rich set of built-in operators, categorized into AI-backed operators and deterministic (pure) operators.

## AI Operators

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
| `wf.ai.repair(input, { run, codec })` | `O` | AI-driven recovery wrapper. |

## Deterministic Operators

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

Call `ops.allDescriptions()` for a formatted, grouped catalog of every operator's options, inputs, and outputs.
