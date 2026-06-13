/**
 * Layer-neutral operational-warning sink.
 *
 * The {@link Logger} contract carries reasoning records, not operational
 * diagnostics, so library warnings (retry notices, ignored refs, empty
 * responses) route through this single shim instead of writing to `console`
 * directly. Hosts embedding the library can silence or redirect every such
 * warning with {@link setWarn} rather than monkey-patching `console`.
 */

/** Receives a fully formatted operational warning message. */
export type WarnFn = (msg: string) => void;

const consoleWarn: WarnFn = (msg) => console.warn(msg);

let sink: WarnFn = consoleWarn;

/**
 * Replaces the process-wide operational-warning sink. Pass null to reset to the
 * default (`console.warn`). Most embedders call this once at program start to
 * route warnings into their own logger or to silence them entirely.
 */
export function setWarn(fn: WarnFn | null): void {
  sink = fn ?? consoleWarn;
}

/** Emits an operational warning through the configured sink. */
export function warn(msg: string): void {
  sink(msg);
}
