/** JSON helpers, composed inside op functions. */

export const parse = <T = unknown>(s: string): T => JSON.parse(s) as T;

export const stringify = (v: unknown, pretty = false): string =>
  JSON.stringify(v, null, pretty ? 2 : undefined);

/**
 * CONVENIENCE dotted-path reader over an already-parsed value, returning the raw
 * value (or undefined). The catalog op is {@link jsonExtract}, which parses a JSON
 * string* and returns a JSON-encoded leaf. Use `get` for in-memory traversal,
 * `jsonExtract` for the op semantics.
 */
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
// JSON op catalog: JSONExtractOp traverses a JSON string by dot-separated path.
// ─────────────────────────────────────────────────────────────────────────────

export const JSONExtractOpDescription =
  `JSONExtractOp: extracts a value from a JSON string using a dot-separated path. Numeric path segments index into arrays (e.g. "meals.0.name"). Inputs: JSON string, Path string. Output: Value string (JSON-encoded leaf, or "" if not found).`;

/** Message wrapped when a required path can't be traversed. */
export const ErrRequiredPathMissing = "required path missing";

/** Type name reported for the scalar leaf types JSONExtractOp can encounter. */
function jsonTypeName(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
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
      `JSONExtractOp: invalid JSON (starts with ${JSON.stringify(snippet)}): ${(err as Error).message}`,
    );
  }
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (key === "") continue;
    if (Array.isArray(cur)) {
      // Only a plain optionally-signed integer literal indexes an array; reject
      // "0x10", "+3", " 1 ", etc. so malformed segments fail rather than coerce.
      const idx = /^-?\d+$/.test(key) ? Number(key) : NaN;
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) {
        if (required)
          throw new Error(
            `JSONExtractOp: index ${JSON.stringify(key)} out of range in path ${JSON.stringify(path)} (len ${cur.length}): ${ErrRequiredPathMissing}`,
          );
        return "";
      }
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      if (!(key in (cur as Record<string, unknown>))) {
        if (required)
          throw new Error(
            `JSONExtractOp: missing key ${JSON.stringify(key)} in path ${JSON.stringify(path)}: ${ErrRequiredPathMissing}`,
          );
        return "";
      }
      cur = (cur as Record<string, unknown>)[key];
    } else {
      if (required)
        throw new Error(
          `JSONExtractOp: cannot traverse ${jsonTypeName(cur)} at key ${JSON.stringify(key)} in path ${JSON.stringify(path)}: ${ErrRequiredPathMissing}`,
        );
      return "";
    }
  }
  if (typeof cur === "string") return cur;
  return JSON.stringify(cur);
}
