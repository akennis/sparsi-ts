/** JSON helpers, composed inside op functions. */

export const parse = <T = unknown>(s: string): T => JSON.parse(s) as T;

export const stringify = (v: unknown, pretty = false): string =>
  JSON.stringify(v, null, pretty ? 2 : undefined);

/** Reads a dotted path (e.g. "a.b.0.c") from a nested value. */
export function get<T = unknown>(obj: unknown, path: string): T | undefined {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur as T | undefined;
}

/** Shallow merge of two records, with `b` winning on key conflicts. */
export const merge = <A extends object, B extends object>(a: A, b: B): A & B => ({
  ...a,
  ...b,
});

// ─────────────────────────────────────────────────────────────────────────────
// Faithful Go op catalog (sparsi-go library/json_ops.go). JSONExtractOp mirrors
// the Go op's traversal semantics and error wording exactly.
// ─────────────────────────────────────────────────────────────────────────────

export const JSONExtractOpDescription =
  `JSONExtractOp: extracts a value from a JSON string using a dot-separated path. Numeric path segments index into arrays (e.g. "meals.0.name"). Inputs: JSON *string, Path *string. Output: Value string (JSON-encoded leaf, or "" if not found).`;

/** Message of the sentinel Go wraps when a required path can't be traversed. */
export const ErrRequiredPathMissing = "required path missing";

/** Quotes a string the way Go's `%q` verb would (close enough for diagnostics). */
const q = (s: string): string => JSON.stringify(s);

/** Go-style `%T` name for the scalar leaf types JSONExtractOp can encounter. */
function goTypeName(v: unknown): string {
  if (v === null) return "<nil>";
  if (typeof v === "number") return "float64";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  return typeof v;
}

/**
 * Extracts a value from `jsonStr` using a dot-separated `path`. Numeric segments
 * index into arrays. Returns the JSON-encoded leaf (raw string for string leaves),
 * or "" when the path is not found. When `required` is true, a missing/invalid
 * path throws instead of returning "".
 */
export function jsonExtract(jsonStr: string, path: string, required = false): string {
  let root: unknown;
  try {
    root = JSON.parse(jsonStr);
  } catch (err) {
    let snippet = jsonStr;
    if (snippet.length > 50) snippet = snippet.slice(0, 50) + "...";
    throw new Error(
      `JSONExtractOp: invalid JSON (starts with ${q(snippet)}): ${(err as Error).message}`,
    );
  }
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (key === "") continue;
    if (Array.isArray(cur)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        if (required)
          throw new Error(
            `JSONExtractOp: index ${q(key)} out of range in path ${q(path)} (len ${cur.length}): ${ErrRequiredPathMissing}`,
          );
        return "";
      }
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      if (!(key in (cur as Record<string, unknown>))) {
        if (required)
          throw new Error(
            `JSONExtractOp: missing key ${q(key)} in path ${q(path)}: ${ErrRequiredPathMissing}`,
          );
        return "";
      }
      cur = (cur as Record<string, unknown>)[key];
    } else {
      if (required)
        throw new Error(
          `JSONExtractOp: cannot traverse ${goTypeName(cur)} at key ${q(key)} in path ${q(path)}: ${ErrRequiredPathMissing}`,
        );
      return "";
    }
  }
  if (typeof cur === "string") return cur;
  return JSON.stringify(cur);
}
