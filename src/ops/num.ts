/** Numeric helpers, composed inside op functions. */

export const add = (a: number, b: number): number => a + b;
export const sub = (a: number, b: number): number => a - b;
export const mul = (a: number, b: number): number => a * b;

export function div(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}

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

export function round(x: number, places = 0): number {
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(Math.max(x, lo), hi);

// ─────────────────────────────────────────────────────────────────────────────
// Faithful Go op catalog (sparsi-go library/math_ops.go). Each function mirrors
// a registered Go operator's Run() semantics and error wording exactly. The
// `*Description` constants are the user-facing op docs (verbatim from Go).
// JS has a single number type; the int variants emulate Go's integer semantics
// (truncating division, integer power, integer modulo).
// ─────────────────────────────────────────────────────────────────────────────

/** Two float64 operands, mirroring Go's MathOperands input struct. */
export interface MathOperands {
  A: number;
  B: number;
}

/** Mirrors MathOperands.FormatForPrompt: `A=<a>, B=<b>`. */
export const formatMathOperands = (m: MathOperands): string =>
  `A=${formatGoFloat(m.A)}, B=${formatGoFloat(m.B)}`;

/**
 * Formats a float64 the way Go's `fmt.Sprintf("%v", …)` does — i.e.
 * `strconv.FormatFloat(v, 'g', -1, 64)`: shortest round-tripping digits, switching
 * to exponential form when the decimal exponent is `< -4` or `>= 21`, with a
 * sign and a minimum-two-digit exponent (e.g. `1e-05`, `1e+21`).
 */
export function formatGoFloat(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  if (v === 0) return "0";

  const neg = v < 0;
  const abs = Math.abs(v);
  const m = abs.toExponential().match(/^(\d)(?:\.(\d+))?e([+-]\d+)$/)!;
  const intDigit = m[1]!;
  const fracDigits = m[2] ?? "";
  const exp = parseInt(m[3]!, 10);
  const digits = intDigit + fracDigits;

  let out: string;
  if (exp < -4 || exp >= 21) {
    const mant = fracDigits ? `${intDigit}.${fracDigits}` : intDigit;
    const esign = exp < 0 ? "-" : "+";
    const eabs = Math.abs(exp).toString().padStart(2, "0");
    out = `${mant}e${esign}${eabs}`;
  } else if (exp < 0) {
    out = "0." + "0".repeat(-exp - 1) + digits;
  } else if (digits.length <= exp + 1) {
    out = digits + "0".repeat(exp + 1 - digits.length);
  } else {
    out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  }
  return neg ? "-" + out : out;
}

// ── Math — float ─────────────────────────────────────────────────────────────

export const AddFloatOpDescription =
  "AddFloatOp: deterministic float64 addition. Inputs: A *float64, B *float64. Output: Result float64.";
export const SubFloatOpDescription =
  "SubFloatOp: A minus B (float64). Inputs: A *float64, B *float64. Output: Result float64.";
export const MulFloatOpDescription =
  "MulFloatOp: A multiplied by B (float64). Inputs: A *float64, B *float64. Output: Result float64.";
export const DivFloatOpDescription =
  "DivFloatOp: A divided by B (float64). Inputs: A *float64, B *float64. Output: Result float64. Error if B==0.";
export const PowFloatOpDescription =
  "PowFloatOp: A raised to the power B (float64). Inputs: A *float64, B *float64. Output: Result float64.";
export const ModFloatOpDescription =
  "ModFloatOp: floating-point remainder of A/B. Inputs: A *float64, B *float64. Output: Result float64. Error if B==0.";
export const RoundOpDescription =
  "RoundOp: rounds Value to nearest integer. Input: Value *float64. Output: Result float64.";
export const ClampFloatOpDescription =
  "ClampFloatOp: clamps Value to [Min, Max] (float64). Inputs: Value *float64, Min *float64, Max *float64. Output: Result float64.";
export const SumFloatOpDescription =
  "SumFloatOp: sums all values in a float64 slice. Input: Values *[]float64. Output: Result float64.";
export const MinFloatOpDescription =
  "MinFloatOp: returns the minimum value in a float64 slice. Input: Values *[]float64. Output: Result float64. Error if empty.";
export const MaxFloatOpDescription =
  "MaxFloatOp: returns the maximum value in a float64 slice. Input: Values *[]float64. Output: Result float64. Error if empty.";
export const PackMathOperandsOpDescription =
  "PackMathOperandsOp: packs two float64 inputs into a MathOperands struct. Inputs: A *float64, B *float64. Output: Result MathOperands.";

export const addFloat = (a: number, b: number): number => a + b;
export const subFloat = (a: number, b: number): number => a - b;
export const mulFloat = (a: number, b: number): number => a * b;

export function divFloat(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}

export const powFloat = (a: number, b: number): number => Math.pow(a, b);

export function modFloat(a: number, b: number): number {
  if (b === 0) throw new Error("modulo by zero");
  return a % b; // JS % matches Go math.Mod: truncated remainder, sign of dividend.
}

/** Rounds half away from zero, matching Go's math.Round (not JS Math.round). */
export const roundFloat = (v: number): number =>
  v < 0 ? -Math.round(-v) : Math.round(v);

export function clampFloat(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const sumFloat = (values: number[]): number =>
  values.reduce((acc, v) => acc + v, 0);

export function minFloat(values: number[]): number {
  if (values.length === 0) throw new Error("MinFloatOp: empty slice");
  let m = values[0]!;
  for (const v of values) if (v < m) m = v;
  return m;
}

export function maxFloat(values: number[]): number {
  if (values.length === 0) throw new Error("MaxFloatOp: empty slice");
  let m = values[0]!;
  for (const v of values) if (v > m) m = v;
  return m;
}

export const packMathOperands = (a: number, b: number): MathOperands => ({ A: a, B: b });

// ── Math — int ───────────────────────────────────────────────────────────────

export const AddIntOpDescription =
  "AddIntOp: deterministic int addition. Inputs: A *int, B *int. Output: Result int.";
export const SubIntOpDescription =
  "SubIntOp: A minus B (int). Inputs: A *int, B *int. Output: Result int.";
export const MulIntOpDescription =
  "MulIntOp: A multiplied by B (int). Inputs: A *int, B *int. Output: Result int.";
export const DivIntOpDescription =
  "DivIntOp: A divided by B (int, truncates toward zero). Inputs: A *int, B *int. Output: Result int. Error if B==0.";
export const PowIntOpDescription =
  "PowIntOp: A raised to the power B (int). Inputs: A *int, B *int. Output: Result int. Error if B<0.";
export const ModIntOpDescription =
  "ModIntOp: integer remainder of A/B. Inputs: A *int, B *int. Output: Result int. Error if B==0.";
export const SumIntOpDescription =
  "SumIntOp: sums all values in an int slice. Input: Values *[]int. Output: Result int.";
export const ClampIntOpDescription =
  "ClampIntOp: clamps Value to [Min, Max] (int). Inputs: Value *int, Min *int, Max *int. Output: Result int.";
export const MinIntOpDescription =
  "MinIntOp: returns the minimum value in an int slice. Input: Values *[]int. Output: Result int. Error if empty.";
export const MaxIntOpDescription =
  "MaxIntOp: returns the maximum value in an int slice. Input: Values *[]int. Output: Result int. Error if empty.";

export const addInt = (a: number, b: number): number => a + b;
export const subInt = (a: number, b: number): number => a - b;
export const mulInt = (a: number, b: number): number => a * b;

export function divInt(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return Math.trunc(a / b); // Go integer division truncates toward zero.
}

export function powInt(a: number, b: number): number {
  if (b < 0) throw new Error("negative exponent for integer power");
  let base = a;
  let exp = b;
  let result = 1;
  while (exp > 0) {
    if (exp % 2 === 1) result *= base;
    base *= base;
    exp = Math.trunc(exp / 2);
  }
  return result;
}

export function modInt(a: number, b: number): number {
  if (b === 0) throw new Error("modulo by zero");
  return a % b; // JS % matches Go integer % (sign of dividend).
}

export const sumInt = (values: number[]): number =>
  values.reduce((acc, v) => acc + v, 0);

export function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function minInt(values: number[]): number {
  if (values.length === 0) throw new Error("MinIntOp: empty slice");
  let m = values[0]!;
  for (const v of values) if (v < m) m = v;
  return m;
}

export function maxInt(values: number[]): number {
  if (values.length === 0) throw new Error("MaxIntOp: empty slice");
  let m = values[0]!;
  for (const v of values) if (v > m) m = v;
  return m;
}

// ── Math — cast ──────────────────────────────────────────────────────────────

export const IntToFloat64OpDescription =
  "IntToFloat64Op: widens an int wire to float64. Input: Value *int. Output: Result float64.";
export const Float64ToIntOpDescription =
  "Float64ToIntOp: truncates a float64 wire to int. Input: Value *float64. Output: Result int.";

export const intToFloat64 = (v: number): number => v;
export const float64ToInt = (v: number): number => Math.trunc(v);
