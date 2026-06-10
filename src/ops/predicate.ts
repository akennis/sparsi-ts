/** Boolean helpers, handy as op functions or in `op` conditions. */

export const gt = (a: number, b: number): boolean => a > b;
export const gte = (a: number, b: number): boolean => a >= b;
export const lt = (a: number, b: number): boolean => a < b;
export const lte = (a: number, b: number): boolean => a <= b;
export const eq = <T>(a: T, b: T): boolean => a === b;
export const neq = <T>(a: T, b: T): boolean => a !== b;

export const and = (...bs: boolean[]): boolean => bs.every(Boolean);
export const or = (...bs: boolean[]): boolean => bs.some(Boolean);
export const not = (b: boolean): boolean => !b;

export const between = (x: number, lo: number, hi: number): boolean =>
  x >= lo && x <= hi;

// ─────────────────────────────────────────────────────────────────────────────
// Predicate op catalog, over a single numeric type. JS has one `number` type, so
// the comparison ops form one numeric if* family. The catalog ops delegate to the
// generic helpers above.
// ─────────────────────────────────────────────────────────────────────────────

// ── Predicate — numeric ──────────────────────────────────────────────────────

export const IfGtOpDescription =
  "IfGtOp: reports whether A > B. Inputs: A *number, B *number. Output: Match bool.";
export const IfLtOpDescription =
  "IfLtOp: reports whether A < B. Inputs: A *number, B *number. Output: Match bool.";
export const IfEqOpDescription =
  "IfEqOp: reports whether A == B. Inputs: A *number, B *number. Output: Match bool.";
export const IfGeOpDescription =
  "IfGeOp: reports whether A >= B. Inputs: A *number, B *number. Output: Match bool.";
export const IfLeOpDescription =
  "IfLeOp: reports whether A <= B. Inputs: A *number, B *number. Output: Match bool.";

// Catalog ops, delegating to the generic comparison helpers.
export const ifGt = gt;
export const ifLt = lt;
export const ifGe = gte;
export const ifLe = lte;
export const ifEq = (a: number, b: number): boolean => a === b;

// ── Predicate — string ───────────────────────────────────────────────────────

export const IfStringContainsOpDescription =
  "IfStringContainsOp: reports whether A contains B as a substring. Inputs: A *string, B *string. Output: Match bool.";
export const IfStringHasPrefixOpDescription =
  "IfStringHasPrefixOp: reports whether A starts with B. Inputs: A *string, B *string. Output: Match bool.";
export const IfStringHasSuffixOpDescription =
  "IfStringHasSuffixOp: reports whether A ends with B. Inputs: A *string, B *string. Output: Match bool.";
export const IfStringRegexMatchOpDescription =
  `IfStringRegexMatchOp: reports whether the input matches a compiled regex. Param: pattern (required). Input: Input *string. Output: Match bool.`;
export const IfStringEqOpDescription =
  "IfStringEqOp: reports whether two strings are equal. Inputs: A *string, B *string. Output: Match bool.";

export const ifStringContains = (a: string, b: string): boolean => a.includes(b);
export const ifStringHasPrefix = (a: string, b: string): boolean => a.startsWith(b);
export const ifStringHasSuffix = (a: string, b: string): boolean => a.endsWith(b);
export const ifStringEq = (a: string, b: string): boolean => a === b;

/**
 * Reports whether `input` matches `pattern`. Pattern is required.
 *
 * Patterns are compiled with JavaScript's `RegExp`, which supports
 * backreferences and lookaround and is not guaranteed linear-time; size or
 * sanitize untrusted patterns accordingly.
 */
export function ifStringRegexMatch(pattern: string, input: string): boolean {
  if (pattern === "")
    throw new Error("IfStringRegexMatchOp: pattern param is required");
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(
      `IfStringRegexMatchOp: invalid pattern "${pattern}": ${(err as Error).message}`,
    );
  }
  return re.test(input);
}

// ── Predicate — empty / range ────────────────────────────────────────────────

export const IfEmptyStringOpDescription =
  "IfEmptyStringOp: reports whether Value is nil or the empty string. Input: Value *string. Output: Match bool.";
export const IfEmptySliceStringOpDescription =
  "IfEmptySliceStringOp: reports whether Value is nil or has length 0. Input: Value *[]string. Output: Match bool.";
export const IfEmptySliceNumberOpDescription =
  "IfEmptySliceNumberOp: reports whether Value is nil or has length 0. Input: Value *[]number. Output: Match bool.";
export const BetweenOpDescription =
  "BetweenOp: reports whether Min <= Value <= Max (inclusive on both ends). Inputs: Value *number, Min *number, Max *number. Output: Match bool.";

export const ifEmptyString = (value: string | null | undefined): boolean =>
  value == null || value === "";
export const ifEmptySliceString = (value: string[] | null | undefined): boolean =>
  value == null || value.length === 0;
export const ifEmptySliceNumber = (value: number[] | null | undefined): boolean =>
  value == null || value.length === 0;

// `between` (defined above) is the single numeric range op.
