/** Numeric helpers, composed inside op functions. */

export const add = (a: number, b: number): number => a + b;
export const sub = (a: number, b: number): number => a - b;
export const mul = (a: number, b: number): number => a * b;

export function div(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}

export const pow = (a: number, b: number): number => Math.pow(a, b);

export function mod(a: number, b: number): number {
  if (b === 0) throw new Error("modulo by zero");
  return a % b; // remainder takes the sign of the dividend.
}

/** Truncates toward zero (the single float→integer bridge). */
export const trunc = (x: number): number => Math.trunc(x);

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function mean(xs: number[]): number {
  if (xs.length === 0) throw new Error("mean of empty array");
  return sum(xs) / xs.length;
}

export function min(xs: number[]): number {
  if (xs.length === 0) throw new Error("min of empty array");
  return Math.min(...xs);
}

export function max(xs: number[]): number {
  if (xs.length === 0) throw new Error("max of empty array");
  return Math.max(...xs);
}

/** Rounds to `places` decimals, half away from zero. */
export function round(x: number, places = 0): number {
  const f = 10 ** places;
  const scaled = x * f;
  const r = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return r / f;
}

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(Math.max(x, lo), hi);

/** Native JS number→string formatting via `String()`. */
export const numberToString = (value: number): string => String(value);

// ─────────────────────────────────────────────────────────────────────────────
// Numeric op catalog, over a single `number` type. TypeScript/JavaScript have one
// numeric type (IEEE-754 double) and no int/float distinction, so the catalog
// exposes only general numeric operations rather than parallel int/float families.
// The `*Description` constants are the user-facing op docs.
// ─────────────────────────────────────────────────────────────────────────────

/** Two numeric operands consumed by the math ops. */
export interface MathOperands {
  A: number;
  B: number;
}

/** Formats operands for a prompt: `A=<a>, B=<b>`. */
export const formatMathOperands = (m: MathOperands): string =>
  `A=${numberToString(m.A)}, B=${numberToString(m.B)}`;

export const packMathOperands = (a: number, b: number): MathOperands => ({ A: a, B: b });

// ── Math ─────────────────────────────────────────────────────────────────────

export const AddOpDescription =
  "AddOp: deterministic numeric addition. Inputs: A *number, B *number. Output: Result number.";
export const SubOpDescription =
  "SubOp: A minus B. Inputs: A *number, B *number. Output: Result number.";
export const MulOpDescription =
  "MulOp: A multiplied by B. Inputs: A *number, B *number. Output: Result number.";
export const DivOpDescription =
  "DivOp: A divided by B. Inputs: A *number, B *number. Output: Result number. Error if B==0.";
export const PowOpDescription =
  "PowOp: A raised to the power B. Inputs: A *number, B *number. Output: Result number.";
export const ModOpDescription =
  "ModOp: remainder of A/B (sign of the dividend). Inputs: A *number, B *number. Output: Result number. Error if B==0.";
export const RoundOpDescription =
  "RoundOp: rounds Value to the nearest integer (half away from zero). Input: Value *number. Output: Result number.";
export const ClampOpDescription =
  "ClampOp: clamps Value to [Min, Max]. Inputs: Value *number, Min *number, Max *number. Output: Result number.";
export const TruncOpDescription =
  "TruncOp: truncates Value toward zero to an integral number. Input: Value *number. Output: Result number.";
export const SumOpDescription =
  "SumOp: sums all values in a numeric slice. Input: Values *[]number. Output: Result number.";
export const MinOpDescription =
  "MinOp: returns the minimum value in a numeric slice. Input: Values *[]number. Output: Result number. Error if empty.";
export const MaxOpDescription =
  "MaxOp: returns the maximum value in a numeric slice. Input: Values *[]number. Output: Result number. Error if empty.";
export const PackMathOperandsOpDescription =
  "PackMathOperandsOp: packs two numeric inputs into a MathOperands struct. Inputs: A *number, B *number. Output: Result MathOperands.";
