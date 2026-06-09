/** Selection / branching helpers, composed inside op functions. */

export const pick = <T, K extends keyof T>(obj: T, key: K): T[K] => obj[key];

export const at = <T>(xs: T[], i: number): T | undefined =>
  xs[i < 0 ? xs.length + i : i];

export const first = <T>(xs: T[]): T | undefined => xs[0];
export const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1];

export const ifElse = <T>(cond: boolean, a: T, b: T): T => (cond ? a : b);

/** First argument that is neither null nor undefined. */
export function coalesceVal<T>(...vals: (T | null | undefined)[]): T | undefined {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Faithful Go op catalog (sparsi-go library/select_ops.go). Each function
// mirrors a registered Go operator's Run() semantics exactly. The `*Description`
// constants are verbatim from Go. JS has a single number type, so the Float64
// and Int select/default variants share one impl.
// ─────────────────────────────────────────────────────────────────────────────

// ── Select (ternary) ─────────────────────────────────────────────────────────

export const SelectStringOpDescription =
  "SelectStringOp: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond *bool, IfTrue *string, IfFalse *string. Output: Result string.";
export const SelectFloat64OpDescription =
  "SelectFloat64Op: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond *bool, IfTrue *float64, IfFalse *float64. Output: Result float64.";
export const SelectIntOpDescription =
  "SelectIntOp: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond *bool, IfTrue *int, IfFalse *int. Output: Result int.";
export const SelectBoolOpDescription =
  "SelectBoolOp: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond *bool, IfTrue *bool, IfFalse *bool. Output: Result bool.";

export const selectString = (cond: boolean, ifTrue: string, ifFalse: string): string =>
  cond ? ifTrue : ifFalse;
export const selectFloat64 = (cond: boolean, ifTrue: number, ifFalse: number): number =>
  cond ? ifTrue : ifFalse;
export const selectInt = (cond: boolean, ifTrue: number, ifFalse: number): number =>
  cond ? ifTrue : ifFalse;
export const selectBool = (cond: boolean, ifTrue: boolean, ifFalse: boolean): boolean =>
  cond ? ifTrue : ifFalse;

// ── Switch ───────────────────────────────────────────────────────────────────

export const SwitchStringOpDescription = `SwitchStringOp: looks up Key in a params-configured cases map; returns the configured default on miss.
  Params: cases — JSON-encoded key→value pairs (e.g. {"red":"stop","green":"go"}).
          default — string returned when Key is nil or not in cases (default "").
  Input:  Key *string.
  Output: Result string.`;

/** Looks up `key` in `cases`; returns `defValue` when key is missing/undefined. */
export function switchString(
  key: string | undefined,
  cases: Record<string, string>,
  defValue = "",
): string {
  if (key === undefined) return defValue;
  return key in cases ? cases[key]! : defValue;
}

// ── Default ──────────────────────────────────────────────────────────────────

export const DefaultStringOpDescription =
  "DefaultStringOp: returns Default when Value is nil or the empty string; otherwise returns Value. Inputs: Value *string, Default *string. Output: Result string.";
export const DefaultFloat64OpDescription =
  "DefaultFloat64Op: returns Default when Value is nil; zero is treated as a valid value. Inputs: Value *float64, Default *float64. Output: Result float64.";
export const DefaultIntOpDescription =
  "DefaultIntOp: returns Default when Value is nil; zero is treated as a valid value. Inputs: Value *int, Default *int. Output: Result int.";

/** Returns `def` when `value` is undefined or empty; otherwise `value`. */
export const defaultString = (value: string | undefined, def: string): string =>
  value === undefined || value === "" ? def : value;

/** Returns `def` when `value` is undefined; zero is a valid value. */
export const defaultFloat64 = (value: number | undefined, def: number): number =>
  value === undefined ? def : value;

/** Returns `def` when `value` is undefined; zero is a valid value. */
export const defaultInt = (value: number | undefined, def: number): number =>
  value === undefined ? def : value;
