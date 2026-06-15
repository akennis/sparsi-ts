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
// Select / switch / default op catalog, over a single numeric type. JS has one
// `number` type, so there is one selectNumber / defaultNumber pair rather than
// separate float/int variants. Nil handling uses `== null` to cover both null and
// undefined.
// ─────────────────────────────────────────────────────────────────────────────

// ── Select (ternary) ─────────────────────────────────────────────────────────

export const SelectStringOpDescription =
  "SelectStringOp: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond boolean, IfTrue string, IfFalse string. Output: Result string.";
export const SelectNumberOpDescription =
  "SelectNumberOp: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond boolean, IfTrue number, IfFalse number. Output: Result number.";
export const SelectBoolOpDescription =
  "SelectBoolOp: ternary; returns IfTrue when Cond is true, otherwise IfFalse. Inputs: Cond boolean, IfTrue boolean, IfFalse boolean. Output: Result boolean.";

export const selectString = (cond: boolean, ifTrue: string, ifFalse: string): string =>
  cond ? ifTrue : ifFalse;
export const selectNumber = (cond: boolean, ifTrue: number, ifFalse: number): number =>
  cond ? ifTrue : ifFalse;
export const selectBool = (cond: boolean, ifTrue: boolean, ifFalse: boolean): boolean =>
  cond ? ifTrue : ifFalse;

// ── Switch ───────────────────────────────────────────────────────────────────

export const SwitchStringOpDescription = `SwitchStringOp: looks up Key in a params-configured cases map; returns the configured default on miss.
  Params: cases — JSON-encoded key→value pairs (e.g. {"red":"stop","green":"go"}).
          default — string returned when Key is nil or not in cases (default "").
  Input:  Key string.
  Output: Result string.`;

/** Looks up `key` in `cases`; returns `defValue` when key is nil (F16). */
export function switchString(
  key: string | null | undefined,
  cases: Record<string, string>,
  defValue = "",
): string {
  if (key == null) return defValue;
  return key in cases ? cases[key]! : defValue;
}

// ── Default ──────────────────────────────────────────────────────────────────

export const DefaultStringOpDescription =
  "DefaultStringOp: returns Default when Value is nil or the empty string; otherwise returns Value. Inputs: Value string, Default string. Output: Result string.";
export const DefaultNumberOpDescription =
  "DefaultNumberOp: returns Default when Value is nil; zero is treated as a valid value. Inputs: Value number, Default number. Output: Result number.";

/** Returns `def` when `value` is nil or empty; otherwise `value` (F16). */
export const defaultString = (value: string | null | undefined, def: string): string =>
  value == null || value === "" ? def : value;

/** Returns `def` when `value` is nil; zero is a valid value. */
export const defaultNumber = (value: number | null | undefined, def: number): number =>
  value == null ? def : value;
