/** String helpers, composed inside op functions. */

import { numberToString } from "./num";

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
// String op catalog: lookup / lowercase / concat / split / regex match & extract,
// plus the string-cast ops. The `*Description` constants are the user-facing op
// docs.
// ─────────────────────────────────────────────────────────────────────────────

// ── String ───────────────────────────────────────────────────────────────────

export const StringLookupOpDescription = `StringLookupOp: looks up Key in a hardcoded string→string map; returns "" on miss.
  Params: map — JSON-encoded key→value pairs (e.g. {"hamburger":"ketchup","hotdog":"mustard"}).
  Input:  Key string.
  Output: Result string (empty string if key not found).`;
export const StringToLowerOpDescription =
  "StringToLowerOp: converts a string to lowercase. Input: Value string. Output: Result string.";
export const StringConcatOpDescription =
  "StringConcatOp: concatenates two strings. Inputs: A string, B string. Output: Result string.";
export const StringSplitOpDescription =
  `StringSplitOp: splits a string by a separator. Param: sep (default ","). Input: Input string. Output: Result string[].`;
export const RegexMatchOpDescription =
  `RegexMatchOp: reports whether the input matches a compiled regex. Param: pattern (required). Input: Input string. Output: Match boolean.`;
export const RegexExtractOpDescription =
  `RegexExtractOp: returns the first match (or submatch group 1 if present) of a regex. Param: pattern (required). Input: Input string. Output: Result string (empty if no match).`;

/** Looks up `key` in `entries`; returns "" on miss (mirrors a nil/missing key). */
export function stringLookup(
  entries: Record<string, string>,
  key: string | null | undefined,
): string {
  if (key == null) return "";
  return entries[key] ?? "";
}

/** Lowercases `value`; a nil input yields "". */
export const stringToLower = (value: string | null | undefined): string =>
  value == null ? "" : value.toLowerCase();

// `stringConcat` is the two-arg StringConcatOp catalog op; `concat` (above) is the
// variadic compose helper used inside op bodies. Both intentionally coexist.
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

/**
 * Compiles `pattern`, throwing a Setup error on an empty or invalid pattern.
 *
 * Patterns are compiled with JavaScript's `RegExp`, which supports
 * backreferences and lookaround and is not guaranteed linear-time; size or
 * sanitize untrusted patterns accordingly.
 */
export function compilePattern(opName: string, pattern: string): RegExp {
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
// JS has a single `number` type, so there is one numberToString cast (rather than
// separate int/float casts), formatting via native String().

export const NumberToStringOpDescription =
  "NumberToStringOp: formats a number as a string (native JS String). Input: Value number. Output: Result string.";
export const BoolToStringOpDescription =
  'BoolToStringOp: formats a bool as string ("true" or "false"). Input: Value boolean. Output: Result string.';
export const ToStringOpDescription =
  "ToStringOp: formats any upstream value as a string. Input: Value (any). Output: Result string.";

/** Re-export of the single numeric→string op, defined in num.ts. */
export { numberToString };
export const boolToString = (value: boolean): string => (value ? "true" : "false");

/**
 * Formats any upstream value as a readable string. Scalars render natively
 * (`99`, `true`, `hi`); composites are JSON-encoded so an array or object yields
 * a legible representation (`[1,2,3]`, `{"a":1}`) instead of `1,2,3` /
 * `[object Object]`.
 */
export function toString(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
