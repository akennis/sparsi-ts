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
// Faithful Go op catalog (sparsi-go library/predicate_ops.go, routing_ops.go).
// Each function mirrors a registered Go operator's Run() semantics and error
// wording exactly. The `*Description` constants are verbatim from Go. JS has a
// single number type, so the float and int comparison variants share one impl.
// ─────────────────────────────────────────────────────────────────────────────

// ── Predicate — float ────────────────────────────────────────────────────────

export const IfFloatGtOpDescription =
  "IfFloatGtOp: reports whether A > B. Inputs: A *float64, B *float64. Output: Match bool.";
export const IfFloatLtOpDescription =
  "IfFloatLtOp: reports whether A < B. Inputs: A *float64, B *float64. Output: Match bool.";
export const IfFloatEqOpDescription =
  "IfFloatEqOp: reports whether A == B. Inputs: A *float64, B *float64. Output: Match bool.";
export const IfFloatGeOpDescription =
  "IfFloatGeOp: reports whether A >= B. Inputs: A *float64, B *float64. Output: Match bool.";
export const IfFloatLeOpDescription =
  "IfFloatLeOp: reports whether A <= B. Inputs: A *float64, B *float64. Output: Match bool.";

export const ifFloatGt = (a: number, b: number): boolean => a > b;
export const ifFloatLt = (a: number, b: number): boolean => a < b;
export const ifFloatEq = (a: number, b: number): boolean => a === b;
export const ifFloatGe = (a: number, b: number): boolean => a >= b;
export const ifFloatLe = (a: number, b: number): boolean => a <= b;

// ── Predicate — int ──────────────────────────────────────────────────────────

export const IfIntGtOpDescription =
  "IfIntGtOp: reports whether A > B. Inputs: A *int, B *int. Output: Match bool.";
export const IfIntLtOpDescription =
  "IfIntLtOp: reports whether A < B. Inputs: A *int, B *int. Output: Match bool.";
export const IfIntEqOpDescription =
  "IfIntEqOp: reports whether A == B. Inputs: A *int, B *int. Output: Match bool.";
export const IfIntGeOpDescription =
  "IfIntGeOp: reports whether A >= B. Inputs: A *int, B *int. Output: Match bool.";
export const IfIntLeOpDescription =
  "IfIntLeOp: reports whether A <= B. Inputs: A *int, B *int. Output: Match bool.";

export const ifIntGt = (a: number, b: number): boolean => a > b;
export const ifIntLt = (a: number, b: number): boolean => a < b;
export const ifIntEq = (a: number, b: number): boolean => a === b;
export const ifIntGe = (a: number, b: number): boolean => a >= b;
export const ifIntLe = (a: number, b: number): boolean => a <= b;

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

/** Reports whether `input` matches `pattern`. Pattern is required. */
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
export const IfEmptySliceFloat64OpDescription =
  "IfEmptySliceFloat64Op: reports whether Value is nil or has length 0. Input: Value *[]float64. Output: Match bool.";
export const BetweenFloatOpDescription =
  "BetweenFloatOp: reports whether Min <= Value <= Max (inclusive on both ends). Inputs: Value *float64, Min *float64, Max *float64. Output: Match bool.";

export const ifEmptyString = (value: string | undefined): boolean =>
  value === undefined || value === "";
export const ifEmptySliceString = (value: string[] | undefined): boolean =>
  value === undefined || value.length === 0;
export const ifEmptySliceFloat64 = (value: number[] | undefined): boolean =>
  value === undefined || value.length === 0;

export const betweenFloat = (value: number, min: number, max: number): boolean =>
  value >= min && value <= max;
