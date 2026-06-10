import type { RunContext } from "../types";
import { aiCompute, retryLoop, RetryError, goQuote } from "./compute";

/** Options common to every AI op. */
export interface AIOpOptions {
  maxRetries?: number;
  model?: string;
}

const numbered = (items: string[]): string =>
  items.map((c, i) => `${i}. ${c}`).join("\n") + "\n";

// ---- Bespoke ops ----

/** Classifies input into exactly one of a fixed set of categories. */
export function modeSelect(
  input: string,
  opts: AIOpOptions & { categories: string[] },
  ctx: RunContext,
): Promise<string> {
  const cats = opts.categories.map((c) => c.trim()).filter(Boolean);
  if (cats.length < 2) throw new Error("modeSelect: at least 2 categories required");
  const catSet = new Set(cats);
  const catList = cats.join(", ");
  const basePrompt =
    `Classify the following input as exactly one of these categories: ${catList}.\n` +
    `Respond with only the category name — no other text.\n` +
    `Input: ${input}`;
  const systemText = ctx.reasoning
    ? 'Respond with a JSON object {"result": "<category>", "reasoning": "<brief explanation>"}. No markdown, no other text.'
    : "Respond with only the requested value. No explanation, no punctuation, no formatting.";

  return retryLoop(
    ctx,
    {
      name: "modeSelect",
      basePrompt,
      systemText,
      maxTokens: ctx.reasoning ? 512 : 64,
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model,
      inputs: { Input: input, Categories: cats },
    },
    (raw) => {
      let result: string;
      let reasoning: string | undefined;
      if (ctx.reasoning) {
        let env: { result?: unknown; reasoning?: string };
        try {
          env = JSON.parse(raw);
        } catch (e) {
          const detail = `expected JSON {result, reasoning}, got ${goQuote(raw)}: ${(e as Error).message}`;
          throw new RetryError(`Previous response was invalid JSON — ${detail}.`, detail);
        }
        result = String(env.result ?? "").trim();
        reasoning = env.reasoning;
      } else {
        result = raw;
      }
      if (!catSet.has(result)) {
        throw new RetryError(
          `Previous result ${goQuote(result)} was invalid — must be exactly one of: ${catList}.`,
          `result ${goQuote(result)} is not one of ${cats.join(", ")}`,
        );
      }
      return { value: result, reasoning };
    },
  );
}

/** Answers a yes/no predicate about the input text. */
export function aiBool(
  input: string,
  opts: AIOpOptions & { predicate: string },
  ctx: RunContext,
): Promise<boolean> {
  const basePrompt = ctx.reasoning
    ? `Answer the following question about the text.\nRespond with a JSON object: {"result": <true or false>, "reasoning": "<brief explanation>"}.\nQuestion: ${opts.predicate}\nText: ${input}`
    : `Answer the following question about the text with only 'true' or 'false'.\nQuestion: ${opts.predicate}\nText: ${input}`;
  const systemText = ctx.reasoning
    ? 'Respond with only a JSON object: {"result": <true|false>, "reasoning": "<explanation>"}. No other text.'
    : "Respond with only 'true' or 'false'.";

  return retryLoop(
    ctx,
    {
      name: "aiBool",
      basePrompt,
      systemText,
      maxTokens: ctx.reasoning ? 256 : 8,
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model,
      inputs: { Input: input, Predicate: opts.predicate },
    },
    (raw) => {
      if (ctx.reasoning) {
        let env: { result?: boolean; reasoning?: string };
        try {
          env = JSON.parse(raw);
        } catch (e) {
          throw new RetryError(
            'Previous response was not valid JSON. Respond with only: {"result": <true|false>, "reasoning": "<string>"}.',
            `expected JSON {result, reasoning}, got ${goQuote(raw)}: ${(e as Error).message}`,
          );
        }
        if (typeof env.result !== "boolean") {
          throw new RetryError(
            'Previous response was not valid JSON. Respond with only: {"result": <true|false>, "reasoning": "<string>"}.',
            `expected boolean result, got ${JSON.stringify(env.result)}`,
          );
        }
        return { value: env.result, reasoning: env.reasoning };
      }
      switch (raw.toLowerCase()) {
        case "true":
          return { value: true };
        case "false":
          return { value: false };
        default:
          throw new RetryError(
            `Previous response ${goQuote(raw)} was invalid. Respond with only 'true' or 'false'.`,
            `expected true or false, got ${goQuote(raw)}`,
          );
      }
    },
  );
}

/** Scores text against a criterion, returning a value in [0,1]. */
export function aiScore(
  input: string,
  opts: AIOpOptions & { criterion: string },
  ctx: RunContext,
): Promise<number> {
  const basePrompt = ctx.reasoning
    ? `Score the following text for ${opts.criterion} on a scale from 0.0 to 1.0.\nRespond with a JSON object: {"score": <float 0.0–1.0>, "reasoning": "<brief explanation>"}.\nText: ${input}`
    : `Score the following text for ${opts.criterion} on a scale from 0.0 to 1.0.\nRespond with only the numeric score. No explanation.\nText: ${input}`;
  const systemText = ctx.reasoning
    ? 'Respond with only a JSON object: {"score": <decimal 0.0–1.0>, "reasoning": "<brief explanation>"}. No other text.'
    : "Respond with only a decimal number between 0.0 and 1.0. No other text.";

  return retryLoop(
    ctx,
    {
      name: "aiScore",
      basePrompt,
      systemText,
      maxTokens: ctx.reasoning ? 256 : 16,
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model,
      inputs: { Input: input, Criterion: opts.criterion },
    },
    (raw) => {
      let score: number;
      let reasoning: string | undefined;
      if (ctx.reasoning) {
        let env: { score?: number; reasoning?: string };
        try {
          env = JSON.parse(raw);
        } catch (e) {
          throw new RetryError(
            'Previous response was not valid JSON. Respond with only: {"score": <float>, "reasoning": "<string>"}.',
            `expected JSON {score, reasoning}, got "${raw}": ${(e as Error).message}`,
          );
        }
        // A missing score defaults to 0 (an in-range value), not a parse failure.
        // A present but non-numeric score is still a retry.
        score = env.score === undefined || env.score === null ? 0 : Number(env.score);
        reasoning = env.reasoning;
        if (Number.isNaN(score) || score < 0 || score > 1) {
          throw new RetryError(
            `Previous score ${env.score} was out of range. The score field must be between 0.0 and 1.0.`,
            `score ${env.score} out of [0,1]`,
          );
        }
      } else {
        score = Number(raw);
        if (raw === "" || Number.isNaN(score)) {
          throw new RetryError(
            `Previous response "${raw}" was not a valid number. Respond with only a decimal number between 0.0 and 1.0.`,
            `expected number, got "${raw}"`,
          );
        }
        if (score < 0 || score > 1) {
          throw new RetryError(
            `Previous score ${score} was out of range. Respond with a number between 0.0 and 1.0.`,
            `score ${score} out of [0,1]`,
          );
        }
      }
      return { value: score, reasoning };
    },
  );
}

/** Classifies text into zero or more of a fixed set of categories. */
export function aiClassifyMultiLabel(
  input: string,
  opts: AIOpOptions & { categories: string[] },
  ctx: RunContext,
): Promise<string[]> {
  const cats = opts.categories.map((c) => c.trim()).filter(Boolean);
  if (cats.length < 2) throw new Error("aiClassifyMultiLabel: at least 2 categories required");
  const catSet = new Set(cats);
  const catList = cats.join(", ");
  const basePrompt = ctx.reasoning
    ? `Classify the following input into zero or more of these categories: ${catList}.\nRespond with a JSON object {"labels": "<comma-separated matching categories or empty string>", "reasoning": "<brief explanation>"}.\nInput: ${input}`
    : `Classify the following input into zero or more of these categories: ${catList}.\nRespond with matching categories as a comma-separated list. If none match, respond with an empty line.\nInput: ${input}`;
  const systemText = ctx.reasoning
    ? 'Respond with only a JSON object {"labels": "<CSV or empty>", "reasoning": "<explanation>"}. No other text.'
    : "Respond with only the requested value. No explanation, no punctuation beyond commas, no formatting.";

  return retryLoop(
    ctx,
    {
      name: "aiClassifyMultiLabel",
      basePrompt,
      systemText,
      maxTokens: 256,
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model,
      inputs: { Input: input, Categories: cats },
    },
    (raw) => {
      let labelsCSV: string;
      let reasoning: string | undefined;
      if (ctx.reasoning) {
        let env: { labels?: string; reasoning?: string };
        try {
          env = JSON.parse(raw);
        } catch (e) {
          throw new RetryError(
            'Previous response was not valid JSON. Respond with only: {"labels": "<CSV>", "reasoning": "<string>"}.',
            `expected JSON {labels, reasoning}, got "${raw}": ${(e as Error).message}`,
          );
        }
        labelsCSV = env.labels ?? "";
        reasoning = env.reasoning;
      } else {
        labelsCSV = raw;
      }
      const labels = labelsCSV
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const invalid = labels.filter((l) => !catSet.has(l));
      if (invalid.length > 0) {
        throw new RetryError(
          `Previous response contained invalid categories: ${invalid.join(", ")}. Use only: ${catList}.`,
          `invalid categories ${invalid.join(", ")}`,
        );
      }
      return { value: labels, reasoning };
    },
  );
}

/** Selects the best-matching candidate for a query, returning its 0-based index. */
export function aiBestMatch(
  query: string,
  candidates: string[],
  opts: AIOpOptions,
  ctx: RunContext,
): Promise<number> {
  const n = candidates.length;
  if (n === 0) throw new Error("aiBestMatch: candidates list is empty");
  const list = numbered(candidates);
  const basePrompt = ctx.reasoning
    ? `Given the query, return the 0-based index of the best matching candidate.\nRespond with a JSON object: {"index": <integer>, "reasoning": "<brief explanation>"}.\nQuery: ${query}\nCandidates:\n${list}`
    : `Given the query, return the 0-based index of the best matching candidate.\nRespond with only the integer index. No explanation.\nQuery: ${query}\nCandidates:\n${list}`;
  const systemText = ctx.reasoning
    ? 'Respond with only a JSON object: {"index": <integer>, "reasoning": "<explanation>"}. No other text.'
    : "Respond with only an integer index.";

  return retryLoop(
    ctx,
    {
      name: "aiBestMatch",
      basePrompt,
      systemText,
      maxTokens: ctx.reasoning ? 256 : 8,
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model,
      inputs: { Query: query, Candidates: candidates },
    },
    (raw) => {
      let idx: number;
      let reasoning: string | undefined;
      if (ctx.reasoning) {
        let env: { index?: number; reasoning?: string };
        try {
          env = JSON.parse(raw);
        } catch (e) {
          throw new RetryError(
            'Previous response was not valid JSON. Respond with only: {"index": <integer>, "reasoning": "<string>"}.',
            `expected JSON {index, reasoning}, got "${raw}": ${(e as Error).message}`,
          );
        }
        idx = Number(env.index);
        reasoning = env.reasoning;
      } else {
        idx = Number(raw);
        if (raw === "" || !Number.isInteger(idx)) {
          throw new RetryError(
            `Previous response "${raw}" was not a valid integer. Respond with only the integer index.`,
            `expected integer index, got "${raw}"`,
          );
        }
      }
      if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
        throw new RetryError(
          `Index ${idx} is out of range. Must be between 0 and ${n - 1}.`,
          `index ${idx} out of range [0,${n})`,
        );
      }
      return { value: idx, reasoning };
    },
  );
}

/** Reranks candidates by relevance, returning a permutation of 0-based indices. */
export function aiRerank(
  query: string,
  candidates: string[],
  opts: AIOpOptions,
  ctx: RunContext,
): Promise<number[]> {
  const n = candidates.length;
  if (n === 0) throw new Error("aiRerank: candidates list is empty");
  const list = numbered(candidates);
  const basePrompt = ctx.reasoning
    ? `Rerank the following candidates by relevance to the query, best first.\nRespond with a JSON object: {"indices": "<comma-separated 0-based indices>", "reasoning": "<brief explanation>"}.\nQuery: ${query}\nCandidates:\n${list}`
    : `Rerank the following candidates by relevance to the query, best first.\nRespond with only the 0-based indices as a comma-separated list. No explanation.\nQuery: ${query}\nCandidates:\n${list}`;
  const systemText = ctx.reasoning
    ? 'Respond with only a JSON object: {"indices": "<CSV of integers>", "reasoning": "<explanation>"}. No other text.'
    : "Respond with only a comma-separated list of integers.";

  return retryLoop(
    ctx,
    {
      name: "aiRerank",
      basePrompt,
      systemText,
      maxTokens: ctx.reasoning ? 512 : 64,
      maxRetries: opts.maxRetries ?? 3,
      model: opts.model,
      inputs: { Query: query, Candidates: candidates },
    },
    (raw) => {
      let indicesCSV: string;
      let reasoning: string | undefined;
      if (ctx.reasoning) {
        let env: { indices?: string; reasoning?: string };
        try {
          env = JSON.parse(raw);
        } catch (e) {
          throw new RetryError(
            'Previous response was not valid JSON. Respond with only: {"indices": "<CSV>", "reasoning": "<string>"}.',
            `expected JSON {indices, reasoning}, got "${raw}": ${(e as Error).message}`,
          );
        }
        indicesCSV = env.indices ?? "";
        reasoning = env.reasoning;
      } else {
        indicesCSV = raw;
      }
      const indices: number[] = [];
      for (const p of indicesCSV.split(",").map((s) => s.trim()).filter(Boolean)) {
        const v = Number(p);
        if (!Number.isInteger(v)) {
          throw new RetryError(
            `Previous response "${raw}" was invalid: expected integer, got "${p}". Respond with comma-separated integers only.`,
            `expected integer, got "${p}"`,
          );
        }
        indices.push(v);
      }
      const valErr = validatePermutation(indices, n);
      if (valErr) {
        throw new RetryError(
          `Previous response was invalid: ${valErr}. Return each index 0-${n - 1} exactly once.`,
          valErr,
        );
      }
      return { value: indices, reasoning };
    },
  );
}

function validatePermutation(indices: number[], n: number): string {
  if (indices.length !== n) return `expected ${n} indices, got ${indices.length}`;
  const seen = new Set<number>();
  for (const idx of indices) {
    if (idx < 0 || idx >= n) return `index ${idx} out of range [0,${n})`;
    if (seen.has(idx)) return `duplicate index ${idx}`;
    seen.add(idx);
  }
  return "";
}

// ---- Thin wrappers over aiCompute ----

/** Summarizes a list of strings into a single string. */
export function aiSummarize(
  items: string[],
  opts: AIOpOptions & { operation: string },
  ctx: RunContext,
): Promise<string> {
  return aiCompute<string>(
    items,
    { operation: opts.operation, output: "string", name: "aiSummarize", maxRetries: opts.maxRetries, model: opts.model },
    ctx,
  );
}

/** Extracts a list of strings from arbitrary text. */
export function aiExtractStringSlice(
  input: string,
  opts: AIOpOptions & { operation: string },
  ctx: RunContext,
): Promise<string[]> {
  return aiCompute<string[]>(
    input,
    { operation: opts.operation, output: "string[]", name: "aiExtractStringSlice", maxRetries: opts.maxRetries, model: opts.model },
    ctx,
  );
}

/** Extracts a key-value record from arbitrary text. */
export function aiExtractMap(
  input: string,
  opts: AIOpOptions & { operation: string },
  ctx: RunContext,
): Promise<Record<string, string>> {
  return aiCompute<Record<string, string>>(
    input,
    { operation: opts.operation, output: "map", name: "aiExtractMap", maxRetries: opts.maxRetries, model: opts.model },
    ctx,
  );
}

/** Converts free-form text to a number. */
export function aiParseNumber(
  input: string,
  opts: (AIOpOptions & { operation?: string }) | undefined,
  ctx: RunContext,
): Promise<number> {
  return aiCompute<number>(
    input,
    {
      operation: opts?.operation ?? "extract the number from the text",
      output: "number",
      name: "aiParseNumber",
      maxRetries: opts?.maxRetries,
      model: opts?.model,
    },
    ctx,
  );
}
