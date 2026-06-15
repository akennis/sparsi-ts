/**
 * MCP op surface. See the individual modules for behavior and the SECURITY notes
 * baked into their doc comments.
 *
 * Two ops:
 *   - {@link mcpCall}: one tool call per run (fresh session, or pooled stdio).
 *   - {@link mcpScript}: a script of many tool calls over one long-lived session.
 *
 * The transport/parsing layer ({@link transport}) is SDK-free and pure; the
 * session layer ({@link client}) wraps `@modelcontextprotocol/sdk` behind a
 * factory seam so tests can inject in-memory/fake sessions.
 */

export {
  splitCSV,
  parseKVList,
  parseTransportSpec,
  resolveMCPConfig,
  mcpLabel,
} from "./transport";
export type {
  MCPTransport,
  MCPTransportSpec,
  MCPConnectionOptions,
  MCPResolvedConfig,
} from "./transport";

export {
  MCPToolError,
  RealMCPSession,
  startMCPSessionFromSpec,
  buildTransport,
  createMCPSession,
  setMCPSessionFactory,
  resetMCPSessionFactory,
  applyStaticHeaders,
} from "./client";
export type { MCPSession, MCPCallOutcome, MCPSessionFactory } from "./client";

export {
  acquireMCPSession,
  prewarmMCPPool,
  shutdownMCPPool,
  resetMCPPool,
  awaitMCPPoolIdle,
  mcpPoolReadyCount,
} from "./pool";

export { mcpCall, setupMCPCall, MCPCallOpDescription } from "./call";
export type { MCPCallOptions, MCPOutputKind } from "./call";

export { mcpScript, setupMCPScript, MCPScriptOpDescription } from "./script";
export type { MCPScriptOptions, MCPScriptCallback, MCPScriptSession } from "./script";

// Side-effect import: installs the `wf.mcp` accessor on Workflow.prototype.
import "./graph";
export { MCPNamespace } from "./graph";
export type {
  MCPNodeOptions,
  MCPCallNodeOptions,
  MCPScriptNodeOptions,
  MCPCallNodeResult,
} from "./graph";
