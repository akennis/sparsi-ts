/** String helpers, composed inside op functions. */

import { formatGoFloat } from "./num";

export const concat = (...parts: string[]): string => parts.join("");
export const join = (xs: string[], sep = ""): string => xs.join(sep);
export const split = (s: string, sep: string): string[] => s.split(sep);
export const trim = (s: string): string => s.trim();
export const lower = (s: string): string => s.toLowerCase();
export const upper = (s: string): string => s.toUpperCase();
export const contains = (s: string, sub: string): boolean => s.includes(sub);

export const replace = (s: string, find: string, repl: string): string =>
  s.split(find).join(repl);

/** Fills a `{name}` template from a record of values. Unknown keys are left as-is. */
export function template(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Faithful Go op catalog (sparsi-go library/string_ops.go, string_cast_ops.go).
// Each function mirrors a registered Go operator's Run() semantics and error
// wording exactly. The `*Description` constants are the user-facing op docs
// (verbatim from Go).
// ─────────────────────────────────────────────────────────────────────────────

// ── String ───────────────────────────────────────────────────────────────────

export const StringLookupOpDescription = `StringLookupOp: looks up Key in a hardcoded string→string map; returns "" on miss.
  Params: map — JSON-encoded key→value pairs (e.g. {"hamburger":"ketchup","hotdog":"mustard"}).
  Input:  Key *string.
  Output: Result string (empty string if key not found).`;
export const StringToLowerOpDescription =
  "StringToLowerOp: converts a string to lowercase. Input: Value *string. Output: Result string.";
export const StringConcatOpDescription =
  "StringConcatOp: concatenates two strings. Inputs: A *string, B *string. Output: Result string.";
export const StringSplitOpDescription =
  `StringSplitOp: splits a string by a separator. Param: sep (default ","). Input: Input *string. Output: Result []string.`;
export const RegexMatchOpDescription =
  `RegexMatchOp: reports whether the input matches a compiled regex. Param: pattern (required). Input: Input *string. Output: Match bool.`;
export const RegexExtractOpDescription =
  `RegexExtractOp: returns the first match (or submatch group 1 if present) of a regex. Param: pattern (required). Input: Input *string. Output: Result string (empty if no match).`;

/** Looks up `key` in `entries`; returns "" on miss (mirrors a nil/missing key). */
export function stringLookup(
  entries: Record<string, string>,
  key: string | undefined,
): string {
  if (key === undefined) return "";
  return entries[key] ?? "";
}

/** Lowercases `value`; an undefined input yields "" (Go leaves Result zero). */
export const stringToLower = (value: string | undefined): string =>
  value === undefined ? "" : value.toLowerCase();

export const stringConcat = (a: string, b: string): string => a + b;

/** Splits by `sep` (default ","), trims each part, and drops empties. */
export function stringSplit(input: string, sep = ","): string[] {
  const out: string[] = [];
  for (const p of input.split(sep)) {
    const t = p.trim();
    if (t !== "") out.push(t);
  }
  return out;
}

/** Compiles `pattern`, throwing the Go Setup error wording on empty/invalid. */
function compilePattern(opName: string, pattern: string): RegExp {
  if (pattern === "") throw new Error(`${opName}: pattern param is required`);
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new Error(`${opName}: invalid pattern "${pattern}": ${(err as Error).message}`);
  }
}

/** Reports whether `input` matches `pattern`. Pattern is required. */
export function regexMatch(pattern: string, input: string): boolean {
  return compilePattern("RegexMatchOp", pattern).test(input);
}

/** First match, or submatch group 1 if the pattern has a group; "" if no match. */
export function regexExtract(pattern: string, input: string): string {
  const re = compilePattern("RegexExtractOp", pattern);
  const m = re.exec(input);
  if (m === null) return "";
  if (m.length > 1) return m[1] ?? "";
  return m[0];
}

// ── String — cast ────────────────────────────────────────────────────────────

export const Float64ToStringOpDescription =
  "Float64ToStringOp: formats a float64 as string using %v. Input: Value *float64. Output: Result string.";
export const IntToStringOpDescription =
  "IntToStringOp: formats an int as string using %v. Input: Value *int. Output: Result string.";
export const BoolToStringOpDescription =
  'BoolToStringOp: formats a bool as string ("true" or "false"). Input: Value *bool. Output: Result string.';
export const ToStringOpDescription =
  "ToStringOp: formats any upstream pointer value as string using %v; accepts any pointer type via reflection (escape hatch for custom struct wires). Input: Value (any pointer). Output: Result string.";

export const float64ToString = (value: number): string => formatGoFloat(value);
export const intToString = (value: number): string => String(value);
export const boolToString = (value: boolean): string => (value ? "true" : "false");

/** Formats any value as Go's `%v` would for common scalar wires. */
export function toString(value: unknown): string {
  if (typeof value === "number") return formatGoFloat(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
