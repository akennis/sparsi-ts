/**
 * WithRepair: AI-driven recovery wrapper around a deterministic op.
 *
 * Expressed as a typed higher-order function over an inner op: the inner op
 * signals a fixable, structural failure by throwing {@link ErrRepairable}; the
 * wrapper forwards `promptPrefix + prompt + promptSuffix` to the LLM with a strict
 * system text, deserializes the response into a fresh input via the configured
 * {@link RepairCodec}, and re-runs the inner op with it.
 *
 * The codec is the structured wire seam: it owns serialization (`encode`, used by
 * callers to render a value into a repair prompt) and deserialization (`decode`,
 * used here to parse the LLM response), so consumers describe a value's wire
 * format once instead of hand-rolling XML/JSON serializers, parsers, escapers, and
 * fence-strippers. Built-in codecs: {@link textCodec}, {@link jsonCodec},
 * {@link xmlCodec}.
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { RunContext } from "../types";
import { requireAI } from "./client";
import { ErrRepairable } from "./compute";

export const WithRepairDescription = `WithRepair: AI-driven recovery wrapper around a deterministic op.
  Mechanism: When the wrapped op throws ErrRepairable, the wrapper forwards the
             error's prompt verbatim (sandwiched by a configured
             promptPrefix/promptSuffix) to the LLM, parses the response into a
             fresh input value via the configured RepairCodec's decode, and re-runs
             the inner op with that value. Up to maxAttempts repair cycles per run;
             non-repairable errors are propagated unchanged.
  Inner contract:
             - The inner op throws ErrRepairable when the failure is structural
               and fixable by an LLM mutation of its input.
             - The configured RepairCodec deserializes the LLM response into the
               inner op's input type (and serializes values into repair prompts).
             - The inner op MUST be idempotent or pure — repair retries re-run it.
  Config:    maxAttempts number — repair cycle budget (default 3).
             model       string — model passed to the provider (default "claude-sonnet-4-6").
             maxTokens   number — LLM response token budget (default 2048).
             promptPrefix/promptSuffix string — wrap the repair prompt verbatim.
  Inputs/Outputs: identical to the wrapped inner op.`;

/** System text for the repair LLM call. */
const REPAIR_SYSTEM_TEXT =
  "You are a strict data-repair assistant. Output exactly what the user asks for, with no prose, no commentary, and no markdown fences.";

// ─── Structured wire codecs ──────────────────────────────────────────────────

/**
 * A bidirectional wire codec for a repair target type `T`. The library owns the
 * mechanical plumbing (response cleanup, escaping); a codec owns the *shape*.
 *
 * - {@link encode} renders a value into the wire text a caller embeds in a repair
 *   prompt (so a corrected value can be shown to the LLM).
 * - {@link decode} parses an LLM repair response back into a value; throw to
 *   signal an unparseable response (the attempt is consumed and the next prompt
 *   is augmented).
 */
export interface RepairCodec<T> {
  /** Serialize a value into the wire text embedded in a repair prompt. */
  encode(value: T): string;
  /** Parse an LLM repair response into a value. Throw on an unparseable response. */
  decode(response: string): T;
}

/** Strips a leading/trailing ``` markdown fence the LLM may emit despite instructions. */
function stripFences(s: string): string {
  s = s.trim();
  if (!s.startsWith("```")) return s;
  const i = s.indexOf("\n");
  if (i >= 0) s = s.slice(i + 1);
  const j = s.lastIndexOf("```");
  if (j >= 0) s = s.slice(0, j);
  return s.trim();
}

/**
 * The identity codec for raw-string repair targets: {@link RepairCodec.encode}
 * passes the string through, {@link RepairCodec.decode} only strips code fences.
 * Use when the inner op parses the corrected text itself (e.g. JSON it validates
 * with rich domain errors).
 */
export function textCodec(): RepairCodec<string> {
  return { encode: (v) => v, decode: (r) => stripFences(r) };
}

/**
 * A JSON codec: {@link RepairCodec.encode} pretty-prints the value,
 * {@link RepairCodec.decode} strips fences and `JSON.parse`s. The caller supplies
 * the value type `T`; parsing is unchecked (`as T`).
 */
export function jsonCodec<T = unknown>(opts?: { indent?: number }): RepairCodec<T> {
  const indent = opts?.indent ?? 2;
  return {
    encode: (v) => JSON.stringify(v, null, indent),
    decode: (r) => JSON.parse(stripFences(r)) as T,
  };
}

/** Field spec for {@link xmlCodec}. */
export interface XMLCodecSpec {
  /** Root element name. */
  root: string;
  /** Child element names, in serialization order; each maps to a string field. */
  fields: readonly string[];
  /** Subset of `fields` that may be absent (omitted from output when empty). */
  optional?: readonly string[];
}

/**
 * A codec for a flat record of string fields rendered as a shallow XML element,
 * backed by `fast-xml-parser` (no hand-rolled escaping/parsing).
 * {@link RepairCodec.encode} emits `<root>\n  <field>escaped</field>...\n</root>`,
 * omitting optional fields whose value is empty; {@link RepairCodec.decode} strips
 * fences and parses the element, omitting optional fields that are absent. Decode
 * throws when the root element is missing.
 *
 * The caller supplies the value type `T` (e.g. a domain interface of string
 * fields); the field/value mapping is treated internally as `Record<string,
 * string>`.
 */
export function xmlCodec<T = Record<string, string>>(spec: XMLCodecSpec): RepairCodec<T> {
  const optional = new Set(spec.optional ?? []);
  const builder = new XMLBuilder({ format: true, indentBy: "  ", suppressEmptyNode: false });
  // parseTagValue:false keeps every field a string, so a numeric-looking
  // <id>123</id> round-trips as "123" rather than the number 123; trimValues
  // mirrors the prior trim-on-extract behaviour.
  const parser = new XMLParser({ parseTagValue: false, trimValues: true });
  return {
    encode: (value) => {
      const rec = value as unknown as Record<string, string>;
      const fields: Record<string, string> = {};
      for (const f of spec.fields) {
        const v = rec[f] ?? "";
        if (optional.has(f) && v.trim() === "") continue;
        fields[f] = v;
      }
      return (builder.build({ [spec.root]: fields }) as string).trim();
    },
    decode: (response) => {
      const cleaned = stripFences(response);
      const parsed = parser.parse(cleaned) as Record<string, unknown>;
      const rootVal = parsed[spec.root];
      if (rootVal === undefined) {
        throw new Error(`xml: no <${spec.root}> element in response`);
      }
      const rec = (rootVal ?? {}) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const f of spec.fields) {
        const raw = rec[f];
        const val = raw === undefined || raw === null ? "" : String(raw);
        if (optional.has(f) && val === "") continue;
        out[f] = val;
      }
      return out as unknown as T;
    },
  };
}

// ─── WithRepair ──────────────────────────────────────────────────────────────

export interface WithRepairConfig<T, O> {
  /**
   * Runs the inner op against the (possibly repaired) input. Throw
   * {@link ErrRepairable} to request an LLM-driven repair of `input`; any other
   * error propagates unchanged.
   */
  run: (input: T, ctx: RunContext) => O | Promise<O>;
  /**
   * The wire codec for `T`. Its {@link RepairCodec.decode} deserializes each LLM
   * repair response into a fresh input value (throw inside `decode` to signal an
   * unparseable response — the attempt is consumed and the next prompt is
   * augmented); its {@link RepairCodec.encode} is what callers use to render a
   * value into the `ErrRepairable` prompt.
   */
  codec: RepairCodec<T>;
  /** Repair cycle budget. Default 3. */
  maxAttempts?: number;
  /** Prepended to ErrRepairable.prompt verbatim. */
  promptPrefix?: string;
  /** Appended to ErrRepairable.prompt verbatim. */
  promptSuffix?: string;
  /** Model passed to the provider. Default "claude-sonnet-4-6". */
  model?: string;
  /** Response token budget for the repair LLM call. Default 2048. */
  maxTokens?: number;
  /** Name used in error messages and reasoning records. */
  name?: string;
}

/**
 * Runs `cfg.run(input)`; on {@link ErrRepairable} it repairs `input` via the LLM
 * and re-runs, up to `maxAttempts` cycles. First-try success makes no LLM call;
 * non-repairable errors propagate unchanged;
 * an unparseable LLM response consumes an attempt (without re-running the inner op)
 * and augments the next prompt; exhaustion throws a "repair attempt(s) exhausted"
 * error wrapping the last failure.
 */
export async function withRepair<T, O>(
  input: T,
  cfg: WithRepairConfig<T, O>,
  ctx: RunContext,
): Promise<O> {
  const name = cfg.name ?? "";
  const tag = name ? `WithRepair[${name}]` : "WithRepair";
  const maxAttempts = cfg.maxAttempts && cfg.maxAttempts > 0 ? cfg.maxAttempts : 3;
  const model = cfg.model ?? "claude-sonnet-4-6";
  const maxTokens = cfg.maxTokens && cfg.maxTokens > 0 ? cfg.maxTokens : 2048;
  const promptPrefix = cfg.promptPrefix ?? "";
  const promptSuffix = cfg.promptSuffix ?? "";

  // Initial run. Success short-circuits with no LLM call.
  let rep: ErrRepairable;
  try {
    const out = await cfg.run(input, ctx);
    // Emit a reasoning record on the happy path too, so the trace is uniform
    // whether or not a repair cycle was needed.
    ctx.logger?.log({
      node: tag,
      reasoning: "no repair needed",
      result: out,
      inputs: { name, max_attempts: maxAttempts },
    });
    return out;
  } catch (err) {
    if (!(err instanceof ErrRepairable)) throw err; // non-repairable propagates unchanged
    rep = err;
  }

  const ai = requireAI(ctx);
  let lastErr: unknown = rep; // last inner-run failure, for the exhaustion wrap

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fullPrompt = promptPrefix + rep.prompt + promptSuffix;

    let res;
    try {
      res = await ai.call(
        {
          system: REPAIR_SYSTEM_TEXT,
          messages: [{ role: "user", content: fullPrompt }],
          model,
          maxTokens,
        },
        ctx.signal,
      );
    } catch (callErr) {
      const msg = callErr instanceof Error ? callErr.message : String(callErr);
      throw new Error(`${tag} attempt ${attempt}: LLM call: ${msg}`);
    }

    let newVal: T;
    try {
      newVal = cfg.codec.decode(res.text);
    } catch (parseErr) {
      // Unparseable: consume the attempt, augment the prompt, do NOT re-run inner.
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      rep = new ErrRepairable(
        rep.prompt + "\n\nYour previous response was unparseable: " + msg + ". Try again.",
        parseErr,
      );
      continue;
    }

    try {
      const out = await cfg.run(newVal, ctx);
      ctx.logger?.log({
        node: tag,
        reasoning: `repaired after ${attempt} attempt(s)`,
        result: out,
        // Input snapshot for the reasoning record.
        inputs: { name, max_attempts: maxAttempts },
      });
      return out;
    } catch (err) {
      if (!(err instanceof ErrRepairable)) throw err; // non-repairable mid-repair propagates
      rep = err;
      lastErr = err;
    }
  }

  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${tag}: ${maxAttempts} repair attempt(s) exhausted: ${lastMsg}`);
}
