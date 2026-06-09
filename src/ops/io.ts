/** Side-effecting IO helpers, composed inside op functions. */

import { readFile as fsRead, writeFile as fsWrite } from "node:fs/promises";

export const readFile = (path: string): Promise<string> =>
  fsRead(path, "utf8");

export const writeFile = (path: string, content: string): Promise<void> =>
  fsWrite(path, content, "utf8");

export const env = (name: string): string | undefined => process.env[name];

export function print(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log(...args);
}

/** Reads all of stdin to a string. Resolves on EOF. */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Faithful Go op catalog (sparsi-go library/io_ops.go). Each function mirrors a
// registered Go operator's Run() semantics and error wording exactly. The
// `*Description` constants are verbatim from Go.
// ─────────────────────────────────────────────────────────────────────────────

export const FileReadOpDescription =
  "FileReadOp: reads a file from disk. Input: Path *string. Output: Content string.";
export const EnvOpDescription =
  "EnvOp: reads an environment variable. Input: Name *string. Output: Value string (empty if unset).";
export const HTTPGetOpDescription =
  "HTTPGetOp: performs an HTTP GET request. Input: URL *string. Outputs: Body string, StatusCode int.";

/** User-Agent string HTTPGetOp sends, verbatim from the Go op. */
const HTTP_GET_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Reads a file from disk as UTF-8, wrapping errors as `FileReadOp: …`. */
export async function fileRead(path: string): Promise<string> {
  try {
    return await fsRead(path, "utf8");
  } catch (err) {
    throw new Error(`FileReadOp: ${(err as Error).message}`);
  }
}

/** Reads an environment variable, returning "" when unset (mirrors EnvOp). */
export const getEnv = (name: string): string => process.env[name] ?? "";

/** Performs an HTTP GET, returning the body and status code. */
export async function httpGet(
  url: string,
  signal?: AbortSignal,
): Promise<{ body: string; statusCode: number }> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": HTTP_GET_USER_AGENT },
      signal,
    });
  } catch (err) {
    throw new Error(`HTTPGetOp: ${(err as Error).message}`);
  }
  let body: string;
  try {
    body = await resp.text();
  } catch (err) {
    throw new Error(`HTTPGetOp: read body: ${(err as Error).message}`);
  }
  return { body, statusCode: resp.status };
}
