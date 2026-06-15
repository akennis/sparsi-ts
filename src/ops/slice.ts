/** Array helpers, composed inside op functions. */

export const take = <T>(xs: T[], n: number): T[] => xs.slice(0, n);
export const drop = <T>(xs: T[], n: number): T[] => xs.slice(n);
export const reverse = <T>(xs: T[]): T[] => [...xs].reverse();
export const unique = <T>(xs: T[]): T[] => [...new Set(xs)];
export const flatten = <T>(xs: T[][]): T[] => xs.flat();

export function chunk<T>(xs: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

// Named `zip2` to avoid colliding with `Workflow.zip` (the headline graph-level
// API that combines array *nodes*); this is a plain 2-array positional helper.
export function zip2<A, B>(as: A[], bs: B[]): [A, B][] {
  const n = Math.min(as.length, bs.length);
  const out: [A, B][] = [];
  for (let i = 0; i < n; i++) out.push([as[i]!, bs[i]!]);
  return out;
}

export const range = (n: number): number[] =>
  Array.from({ length: Math.max(0, n) }, (_, i) => i);

// ─────────────────────────────────────────────────────────────────────────────
// Slice op catalog: len / at / first / last / contains / join / filter / top-k.
// The `*Description` constants are the user-facing op docs. The string ops are
// typed to string[]; the index/length/top-k helpers are generic where the element
// type is immaterial.
// ─────────────────────────────────────────────────────────────────────────────

export const SliceLenOpDescription =
  "SliceLenOp: returns the length of a string slice. Input: Input string[]. Output: Result number.";
export const SliceAtOpDescription =
  "SliceAtOp: returns the element at a given index. Param: index (number, used when Index wire is absent). Inputs: Input string[], Index number (optional wire). Output: Result string.";
export const SliceFirstOpDescription =
  "SliceFirstOp: returns the first element. Input: Input string[]. Output: Result string. Error if empty.";
export const SliceLastOpDescription =
  "SliceLastOp: returns the last element. Input: Input string[]. Output: Result string. Error if empty.";
export const SliceContainsOpDescription =
  "SliceContainsOp: reports whether a slice contains a value. Inputs: Input string[], Value string. Output: Match boolean.";
export const SliceJoinOpDescription =
  `SliceJoinOp: joins a string slice with a separator. Param: sep (default ","). Input: Input string[]. Output: Result string.`;
export const SliceFilterEqOpDescription =
  "SliceFilterEqOp: returns elements equal to Value. Inputs: Input string[], Value string. Output: Result string[].";
export const SliceTopKOpDescription =
  "SliceTopKOp: returns indices of the K highest scores in descending order. Param: k (number). Input: Scores number[]. Output: Result number[].";

export const sliceLen = <T>(input: T[]): number => input.length;

/** Element at `index`; throws when out of range (no negative-index wrap). */
export function sliceAt<T>(input: T[], index = 0): T {
  if (index < 0 || index >= input.length)
    throw new Error(`SliceAtOp: index ${index} out of range (len ${input.length})`);
  return input[index]!;
}

export function sliceFirst<T>(input: T[]): T {
  if (input.length === 0) throw new Error("SliceFirstOp: empty slice");
  return input[0]!;
}

export function sliceLast<T>(input: T[]): T {
  if (input.length === 0) throw new Error("SliceLastOp: empty slice");
  return input[input.length - 1]!;
}

export const sliceContains = <T>(input: T[], value: T): boolean =>
  input.includes(value);

export const sliceJoin = (input: string[], sep = ","): string => input.join(sep);

export const sliceFilterEq = <T>(input: T[], value: T): T[] =>
  input.filter((s) => s === value);

/**
 * Indices of the K highest scores, descending. `k` defaults to 1. Ties are broken
 * by ascending original index, so the result is deterministic.
 */
export function sliceTopK(scores: number[], k = 1): number[] {
  if (!Number.isInteger(k) || k < 1)
    throw new Error(`SliceTopKOp: invalid k "${k}"`);
  const indices = scores.map((_, i) => i);
  indices.sort((i, j) => scores[j]! - scores[i]! || i - j);
  return indices.slice(0, Math.min(k, indices.length));
}
