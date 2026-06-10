import type { AIMessage, RunContext } from "../types";
import { requireAI } from "./client";

/**
 * Thrown by a validator when the model's answer parsed but is semantically wrong
 * in a way a follow-up turn can fix. The engine threads `prompt` to the model as
 * the next conversational turn.
 */
export class ErrRepairable extends Error {
  override readonly cause?: unknown;
  constructor(
    readonly prompt: string,
    cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause ?? "repairable"));
    this.name = "ErrRepairable";
    this.cause = cause;
  }
}

/**
 * Built-in scalar/collection output shapes the generic parser understands.
 *
 * TypeScript has a single `number` type (IEEE-754 double) and no int/float
 * distinction, so there is one `number`/`number[]` kind that parses any JS
 * numeric literal.
 */
export type OutputKind =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "number[]"
  | "map";

const FORMAT: Record<OutputKind, string> = {
  string: "Respond with the result string only. No quotes, no punctuation, no explanation.",
  number:
    "Respond with the numeric result as a plain decimal number only. No explanation. Example: 42.5",
  boolean: "Respond with true or false only. No explanation.",
  "string[]":
    "Respond with a comma-separated list of values only. No brackets, no quotes, no explanation. Example: Tokyo,Seoul,Beijing",
  "number[]":
    "Respond with a comma-separated list of decimal numbers only. No brackets, no explanation. Example: 1.5,2.0,3.7",
  map: "Respond with comma-separated key=value pairs only. No explanation. Example: name=Alice,city=Tokyo,role=engineer",
};

const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");

/** Parses a trimmed model answer into the requested output kind. Throws on mismatch. */
export function parseResult(kind: OutputKind, raw: string): unknown {
  const s = raw.trim();
  switch (kind) {
    case "string":
      return s;
    case "number": {
      const n = Number(s);
      if (s === "" || !Number.isFinite(n)) throw new Error(`expected number, got "${s}"`);
      return n;
    }
    case "boolean":
      switch (s.toLowerCase()) {
        case "true":
        case "yes":
          return true;
        case "false":
        case "no":
          return false;
        default:
          throw new Error(`expected bool (true/false), got "${s}"`);
      }
    case "string[]":
      return s === "" ? [] : csv(s);
    case "number[]":
      return s === ""
        ? []
        : csv(s).map((p) => {
            const n = Number(p);
            if (!Number.isFinite(n)) throw new Error(`expected number[] CSV, got "${s}"`);
            return n;
          });
    case "map": {
      if (s === "") return {};
      const m: Record<string, string> = {};
      for (const pair of csv(s)) {
        const idx = pair.indexOf("=");
        if (idx < 0) throw new Error(`expected key=value pair, got "${pair}"`);
        m[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
      }
      return m;
    }
    default: {
      // Rejects an unsupported output type; the `never` binding makes this a
      // compile-time exhaustiveness check too.
      const exhaustive: never = kind;
      throw new Error(`unsupported output type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Renders a value with the field-name-preserving layout used for non-string
 * inputs: arrays as `[a b c]`, plain objects as `{key:val key2:val2}`, and
 * scalars via their default string form. Composites recurse.
 */
function describeValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `[${v.map(describeValue).join(" ")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}:${describeValue(val)}`)
      .join(" ")}}`;
  }
  return String(v);
}

/**
 * Renders an op input for prompt interpolation. A string is used verbatim and a
 * string array becomes a 1-based numbered list — the two shapes the shipped
 * wrappers actually feed. Any other value falls back to {@link describeValue}'s
 * field-preserving layout. A caller-supplied `format` overrides all of this.
 */
/**
 * Quotes a string for diagnostic messages the way a double-quoted source
 * literal would: surrounding quotes plus escaped control and quote characters.
 * Used wherever a prior model response is echoed back into an error or retry
 * prompt so embedded newlines/quotes don't corrupt it.
 */
export const goQuote = (s: string): string => JSON.stringify(s);

function describeInput(input: unknown, format?: (v: unknown) => string): string {
  if (format) return format(input);
  if (typeof input === "string") return input;
  if (Array.isArray(input) && input.every((v) => typeof v === "string")) {
    return input.map((v, i) => `${i + 1}. ${v}`).join("\n");
  }
  return describeValue(input);
}

export interface AIComputeOptions<Out> {
  /** Plain-English description of the computation, interpolated into the prompt. */
  operation: string;
  /** Output shape used for built-in parsing and the format hint. */
  output: OutputKind;
  /** Parse/repair attempts beyond the first. Default 3. */
  maxRetries?: number;
  /** Overrides the client's default model for this op. */
  model?: string;
  maxTokens?: number;
  /** Custom input renderer (analogous to AIInputFormatter). */
  formatInput?: (input: unknown) => string;
  /** Overrides the built-in format hint (analogous to AIOutputFormatter). */
  expectedFormat?: string;
  /**
   * Semantic check run after parsing. Throw {@link ErrRepairable} to trigger
   * conversational repair, or a plain Error to trigger a stateless retry.
   */
  validate?: (value: Out) => void;
  /** Node name used in reasoning records. */
  name?: string;
}

const RETRY_SYSTEM_REASONING =
  'Respond with a JSON object {"result": <your answer in the format described>, "reasoning": "<brief explanation>"}. No markdown, no other text.';
const RETRY_SYSTEM_PLAIN =
  "Respond only with the requested format. Do not include any explanation or markdown formatting.";

/**
 * Generic AI compute primitive: builds a prompt from `operation` + `input`,
 * parses the answer to `output`, and retries with feedback (or repairs
 * conversationally) until it parses and validates. Returns the parsed value.
 */
export async function aiCompute<Out>(
  input: unknown,
  opts: AIComputeOptions<Out>,
  ctx: RunContext,
): Promise<Out> {
  const ai = requireAI(ctx);
  const maxRetries = opts.maxRetries ?? 3;
  // The reasoning node and exhaustion error are labeled "AIComputeOp" by default
  // (callers may override via `name`).
  const name = opts.name ?? "AIComputeOp";
  const isReasoning = ctx.reasoning;

  const inputDesc = describeInput(input, opts.formatInput);
  const formatDesc = opts.expectedFormat ?? FORMAT[opts.output];
  const basePrompt = `You are computing: ${opts.operation}\nInput: ${inputDesc}\n${formatDesc}`;
  const systemText = isReasoning ? RETRY_SYSTEM_REASONING : RETRY_SYSTEM_PLAIN;

  let prevResponse = "";
  let prevErr = "";
  let history: AIMessage[] = [];
  let nextPrompt = "";
  let conversational = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const messages: AIMessage[] = [];
    let sentPrompt: string;
    if (conversational) {
      messages.push(...history);
      sentPrompt = nextPrompt;
    } else {
      sentPrompt = basePrompt;
      if (prevResponse !== "") {
        sentPrompt += `\nPrevious response: ${prevResponse}\nParse error: ${prevErr}\nTry again.`;
      }
    }
    messages.push({ role: "user", content: sentPrompt });

    const res = await ai.call(
      { system: systemText, messages, model: opts.model, maxTokens: opts.maxTokens ?? 16 * 1024 },
      ctx.signal,
    );
    const raw = res.text.trim();

    const envelopeFailed = (detail: string): void => {
      if (conversational) {
        history = [
          ...history,
          { role: "user", content: sentPrompt },
          { role: "assistant", content: raw },
        ];
        nextPrompt = `Your last response could not be parsed: ${detail}. Please try again, following the original format exactly.`;
      } else {
        prevResponse = raw;
        prevErr = detail;
      }
    };

    let resultStr: string;
    let reasoning = "";
    if (isReasoning) {
      let envelope: { result?: unknown; reasoning?: string };
      try {
        envelope = JSON.parse(raw);
      } catch (e) {
        envelopeFailed(`expected JSON {result, reasoning}, got ${goQuote(raw)}: ${(e as Error).message}`);
        continue;
      }
      // `result` is kept as raw JSON text: a JSON string is taken verbatim;
      // anything else (number/object/array/null) becomes its literal JSON text so
      // downstream structured parsing works (`null` → "null", `{"a":1}` stays
      // `{"a":1}`). An absent field is the empty string.
      if (typeof envelope.result === "string") {
        resultStr = envelope.result;
      } else if (envelope.result === undefined) {
        resultStr = "";
      } else {
        resultStr = JSON.stringify(envelope.result).trim();
      }
      reasoning = envelope.reasoning ?? "";
    } else {
      resultStr = raw;
    }

    let value: Out;
    try {
      value = parseResult(opts.output, resultStr) as Out;
      opts.validate?.(value);
    } catch (err) {
      if (err instanceof ErrRepairable) {
        history = [
          ...history,
          { role: "user", content: sentPrompt },
          { role: "assistant", content: raw },
        ];
        nextPrompt = err.prompt;
        conversational = true;
        continue;
      }
      envelopeFailed((err as Error).message);
      continue;
    }

    if (isReasoning)
      ctx.logger?.log({
        node: name,
        reasoning,
        result: value,
        inputs: { Operation: opts.operation, Input: inputDesc },
      });
    return value;
  }

  const lastDetail = conversational ? `last prompt: ${nextPrompt}` : `last error: ${prevErr}`;
  throw new Error(`${name}: all ${maxRetries + 1} attempts failed; ${lastDetail}`);
}

/** Internal: corrective retry signal carrying the addendum to append to the base prompt. */
export class RetryError extends Error {
  constructor(
    readonly addendum: string,
    message: string,
  ) {
    super(message);
    this.name = "RetryError";
  }
}

export interface RetryLoopSpec {
  name: string;
  basePrompt: string;
  systemText: string;
  maxTokens: number;
  maxRetries: number;
  model?: string;
  /** Input snapshot recorded on the reasoning entry. */
  inputs?: Record<string, unknown>;
}

/**
 * Shared retry loop for the bespoke AI ops. `parse` returns a value (and optional
 * reasoning) or throws {@link RetryError} to retry with a corrective addendum.
 */
export async function retryLoop<T>(
  ctx: RunContext,
  spec: RetryLoopSpec,
  parse: (raw: string) => { value: T; reasoning?: string },
): Promise<T> {
  const ai = requireAI(ctx);
  let prompt = spec.basePrompt;
  let lastErr = "";
  for (let attempt = 0; attempt <= spec.maxRetries; attempt++) {
    const res = await ai.call(
      {
        system: spec.systemText,
        messages: [{ role: "user", content: prompt }],
        model: spec.model,
        maxTokens: spec.maxTokens,
      },
      ctx.signal,
    );
    const raw = res.text.trim();
    try {
      const { value, reasoning } = parse(raw);
      if (ctx.reasoning && reasoning !== undefined) {
        ctx.logger?.log({ node: spec.name, reasoning, result: value, inputs: spec.inputs });
      }
      return value;
    } catch (err) {
      if (err instanceof RetryError) {
        lastErr = err.message;
        prompt = `${spec.basePrompt}\n\n${err.addendum}`;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`${spec.name}: all ${spec.maxRetries + 1} attempts failed; last error: ${lastErr}`);
}
