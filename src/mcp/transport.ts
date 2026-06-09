/**
 * MCP transport-spec parsing & config resolution — the pure (SDK-free) layer.
 *
 * Faithful port of the parsing/validation logic in sparsi-go's mcp_call_op.go
 * (mcpParseTransportSpec, mcpParseDurationMs, mcpParsePoolSize,
 * mcpParsePoolPrewarm, mcpSplitCSV) and mcp_client.go's mcpTransportSpec.label.
 *
 * Go threads these through `*config.Params` string params populated at graph
 * build. sparsi-ts replaces the string-keyed param bag with a typed options
 * object; the Go `Setup`-time `strconv.Atoi`/`url.Parse`/`exec.LookPath` guards
 * become call-time typed-argument guards here. Every error string and every
 * default (init 10000ms, call 30000ms, retries 3, pool 0/prewarm true, stdio
 * default transport, http/https scheme requirement, headers sorted for pool-key
 * canonicalization) is preserved.
 *
 * This module deliberately imports NO MCP SDK code so the parsing/validation is
 * unit-testable without a server or the SDK.
 */

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

/** Transport selector: a local subprocess ("stdio") or remote HTTP ("http"). */
export type MCPTransport = "stdio" | "http";

/**
 * Canonicalized description of how to reach one MCP server. Vertices populate
 * this; the pool keys on it; {@link buildTransport} turns it into a concrete SDK
 * transport. `env` is a list of `KEY=VALUE` pairs in input order; `headers` is a
 * list of `KEY=VALUE` pairs sorted for pool-key stability (matching Go).
 */
export interface MCPTransportSpec {
  kind: MCPTransport;
  // stdio
  command: string;
  args: string[];
  env: string[];
  // http
  url: string;
  headers: string[];
}

/**
 * Shared connection options for {@link mcpCall} / {@link mcpScript}. The typed
 * idiom for Go's `config.Params`: `transport` selects the leg; the stdio/http
 * fields are validated only for the chosen leg. `env`/`headers` accept a record
 * (idiomatic) — use {@link parseKVList} to build one from the Go CSV form.
 */
export interface MCPConnectionOptions {
  /** "stdio" (default) runs a local subprocess; "http" talks to a remote server. */
  transport?: MCPTransport;

  // stdio
  /** Server executable (e.g. "npx", "uvx", "/abs/path"). Required for stdio. */
  command?: string;
  /** CLI args passed to the server. */
  args?: string[];
  /** Extra environment variables added to the subprocess. */
  env?: Record<string, string>;

  // http
  /** Full endpoint URL (http or https scheme). Required for http. */
  url?: string;
  /** Static headers injected into every request without overwriting protocol headers. */
  headers?: Record<string, string>;

  /** Handshake timeout in ms (default 10000; negative/NaN → default). */
  initTimeoutMs?: number;
  /** Single tool-call timeout in ms (default 30000; negative/NaN → default). */
  callTimeoutMs?: number;
  /** Transient-error retries (default 3; NaN/non-finite → default). */
  maxRetries?: number;
  /** Warm-pool target per spec key (default 0 = no pool; stdio only). */
  poolSize?: number;
  /** When poolSize > 0, prewarm during setup (default true). */
  poolPrewarm?: boolean;
}

/** Resolved, validated config shared by both MCP ops (the "Setup" output). */
export interface MCPResolvedConfig {
  spec: MCPTransportSpec;
  initTimeoutMs: number;
  callTimeoutMs: number;
  maxRetries: number;
  poolSize: number;
  poolPrewarm: boolean;
}

/** Human-readable identifier for log/error messages (url for http, else command). */
export function mcpLabel(spec: MCPTransportSpec): string {
  return spec.kind === "http" ? spec.url : spec.command;
}

/**
 * Splits a comma-separated list: trims each part and drops empties. Mirrors Go's
 * `mcpSplitCSV` (empty input → empty list). Exported for callers migrating from
 * the Go CSV param style.
 */
export function splitCSV(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  for (const raw of s.split(",")) {
    const p = raw.trim();
    if (p !== "") out.push(p);
  }
  return out;
}

/**
 * Parses a comma-separated `KEY=VALUE` list into a record, dropping entries with
 * no `=` or an empty key (the malformed-drop semantics of Go's env/headers
 * parsing). Later keys win on collision. Convenience for users whose config
 * arrives in the Go CSV form (e.g. `env: parseKVList("FOO=bar,BAZ=qux")`).
 */
export function parseKVList(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of splitCSV(s)) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue; // no '=' or empty key → drop (malformed)
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/** Converts a record into `KEY=VALUE[]`, dropping empty keys. */
function recordToKV(rec: Record<string, string> | undefined): string[] {
  if (!rec) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(rec)) {
    const key = k.trim();
    if (key === "") continue;
    out.push(`${key}=${v}`);
  }
  return out;
}

/** Resolves a non-negative duration in ms; negative/NaN/undefined → default. */
function resolveDurationMs(ms: number | undefined, defaultMs: number): number {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return defaultMs;
  return ms;
}

/** Resolves max-retries; non-finite → default 3 (mirrors Go's Atoi fallback). */
function resolveMaxRetries(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return 3;
  return Math.trunc(n);
}

/** Resolves pool size; missing/non-finite/negative → 0 (no pool). */
function resolvePoolSize(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/**
 * Resolves an executable on PATH, mirroring Go's `exec.LookPath`. A command
 * containing a path separator is checked directly; a bare name is searched
 * across PATH entries (consulting PATHEXT on Windows). Throws when not found.
 */
function lookPath(command: string): string {
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];

  const tryResolve = (base: string): string | null => {
    if (isFile(base)) return base;
    if (isWin) {
      for (const ext of exts) {
        if (isFile(base + ext)) return base + ext;
      }
    }
    return null;
  };

  const hasSep =
    command.includes("/") || (isWin && command.includes("\\")) || command.includes(path.sep);
  if (hasSep) {
    const resolved = tryResolve(path.resolve(command));
    if (resolved) return resolved;
    throw new Error(`"${command}" not found`);
  }

  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const resolved = tryResolve(path.join(dir, command));
    if (resolved) return resolved;
  }
  throw new Error(`"${command}" not found in $PATH`);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Validates transport-selection options for the chosen kind and returns a
 * canonical {@link MCPTransportSpec}. `opName` prefixes error messages so the
 * MCPCallOp / MCPScriptOp callers get contextual diagnostics. Error wording
 * matches the Go original verbatim.
 */
export function parseTransportSpec(
  opts: MCPConnectionOptions,
  opName: string,
): MCPTransportSpec {
  const kind = (opts.transport ?? "stdio").toString().toLowerCase().trim() || "stdio";

  if (kind === "stdio") {
    const command = (opts.command ?? "").trim();
    if (command === "") {
      throw new Error(`${opName}: 'command' param is required for transport="stdio"`);
    }
    try {
      lookPath(command);
    } catch (err) {
      throw new Error(
        `${opName}: command "${command}" not found on PATH: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return {
      kind: "stdio",
      command,
      args: opts.args ? [...opts.args] : [],
      env: recordToKV(opts.env),
      url: "",
      headers: [],
    };
  }

  if (kind === "http") {
    const raw = (opts.url ?? "").trim();
    if (raw === "") {
      throw new Error(`${opName}: 'url' param is required for transport="http"`);
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch (err) {
      throw new Error(
        `${opName}: invalid url "${raw}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const scheme = parsed.protocol.replace(/:$/, "");
    if (scheme !== "http" && scheme !== "https") {
      throw new Error(`${opName}: url "${raw}" must use http or https scheme (got "${scheme}")`);
    }
    const headers = recordToKV(opts.headers).sort();
    return {
      kind: "http",
      command: "",
      args: [],
      env: [],
      url: raw,
      headers,
    };
  }

  throw new Error(`${opName}: unknown transport "${kind}" (want "stdio" or "http")`);
}

/**
 * Parses + validates the full shared MCP config (the "Setup" analog). Builds the
 * transport spec, resolves the timeouts/retries/pool defaults, and enforces the
 * v1 rule that pooling is stdio-only.
 */
export function resolveMCPConfig(
  opts: MCPConnectionOptions,
  opName: string,
): MCPResolvedConfig {
  const spec = parseTransportSpec(opts, opName);
  const poolSize = resolvePoolSize(opts.poolSize);
  if (poolSize > 0 && spec.kind !== "stdio") {
    throw new Error(
      `${opName}: pool_size > 0 is only supported for transport="stdio" in v1 (got transport="${spec.kind}")`,
    );
  }
  return {
    spec,
    initTimeoutMs: resolveDurationMs(opts.initTimeoutMs, 10000),
    callTimeoutMs: resolveDurationMs(opts.callTimeoutMs, 30000),
    maxRetries: resolveMaxRetries(opts.maxRetries),
    poolSize,
    poolPrewarm: opts.poolPrewarm ?? true,
  };
}
