/**
 * WithRepair: AI-driven recovery wrapper around a deterministic op.
 *
 * Faithful port of sparsi-go library/with_repair.go, expressed idiomatically as
 * a typed higher-order function over an inner op rather than Go's reflection-based
 * IOperator/SetInputField/UnmarshalRepair scaffolding. The behavioral contract is
 * identical: the inner op signals a fixable, structural failure by throwing
 * {@link ErrRepairable}; the wrapper forwards `promptPrefix + prompt + promptSuffix`
 * to the LLM with a strict system text, deserializes the response into a fresh
 * input via the typed `parse` callback, and re-runs the inner op with it.
 */

import type { RunContext } from "../types";
import { requireAI } from "./client";
import { ErrRepairable } from "./compute";

export const WithRepairDescription = `WithRepair: AI-driven recovery wrapper around a deterministic op.
  Mechanism: When the wrapped op throws library.ErrRepairable, the wrapper
             forwards the error's prompt verbatim (sandwiched by a configured
             promptPrefix/promptSuffix) to the LLM, parses the response into a
             fresh input value via the configured parse callback, and re-runs the
             inner op with that value. Up to maxAttempts repair cycles per run;
             non-repairable errors are propagated unchanged.
  Inner contract:
             - The inner op throws library.ErrRepairable when the failure is
               structural and fixable by an LLM mutation of its input.
             - The parse callback deserializes the LLM response into the inner
               op's input type (the analog of Go's RepairableInput.UnmarshalRepair).
             - The inner op MUST be idempotent or pure — repair retries re-run it.
  Config:    maxAttempts number — repair cycle budget (default 3).
             model       string — model passed to the provider (default "claude-sonnet-4-6").
             maxTokens   number — LLM response token budget (default 2048).
             promptPrefix/promptSuffix string — wrap the repair prompt verbatim.
  Inputs/Outputs: identical to the wrapped inner op.`;

/** Verbatim Go system text for the repair LLM call (with_repair.go Run). */
const REPAIR_SYSTEM_TEXT =
  "You are a strict data-repair assistant. Output exactly what the user asks for, with no prose, no commentary, and no markdown fences.";

export interface WithRepairConfig<T, O> {
  /**
   * Runs the inner op against the (possibly repaired) input. Throw
   * {@link ErrRepairable} to request an LLM-driven repair of `input`; any other
   * error propagates unchanged.
   */
  run: (input: T, ctx: RunContext) => O | Promise<O>;
  /**
   * Deserializes an LLM repair response into a fresh input value. The analog of
   * Go's `RepairableInput.UnmarshalRepair`: throw to signal an unparseable
   * response (the attempt is consumed and the next prompt is augmented).
   */
  parse: (response: string) => T;
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
 * and re-runs, up to `maxAttempts` cycles. Mirrors with_repair.go Run exactly:
 * first-try success makes no LLM call; non-repairable errors propagate unchanged;
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
    return await cfg.run(input, ctx);
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
      newVal = cfg.parse(res.text);
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
        // Go's WithRepair Inputs snapshot is {name, input_field, max_attempts};
        // `input_field` is a reflection field name with no typed-TS analogue.
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
