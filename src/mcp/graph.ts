/**
 * The `wf.mcp.*` node-constructor surface for MCP ops.
 *
 * MCP ops used to be free `(value, opts, ctx)` functions paired with a separate
 * `setup*` call, so every call site had to: run `setupMCPCall`/`setupMCPScript`
 * by hand (easy to forget — that is what prewarms the stdio pool), then re-wrap
 * the per-run op in `wf.op`, declare the input twice, name the thing twice, and
 * courier `ctx` (Finding A, MCP tail). These constructors take an input *node*
 * and return an output *node* — exactly like `wf.ai.*`/`wf.rag.*`/`wf.map` — with
 * the engine supplying `ctx` internally and a single `name`.
 *
 * Setup is folded in: each constructor runs `setupMCP*` at construct (build)
 * time, so validation and pool prewarming happen where build-time work belongs
 * and can no longer be forgotten. The per-run op body then calls the bare
 * `mcpCall`/`mcpScript` (which never prewarm — see those modules).
 *
 * Layering mirrors `src/ai/graph.ts` and `src/rag/graph.ts`: this module depends
 * on `Workflow` (core), never the reverse. It installs the `mcp` accessor by
 * augmenting `Workflow.prototype`, so core `workflow.ts` never imports the MCP
 * surface. The accessor is live as soon as the `mcp` package is imported (which
 * any MCP op already requires).
 */

import { Workflow } from "../workflow";
import type { Node } from "../types";
import type { AIComputeResult, OutputKind } from "../ai/compute";
import { mcpCall, setupMCPCall, type MCPCallOptions, type MCPOutputKind } from "./call";
import { mcpScript, setupMCPScript, type MCPScriptOptions } from "./script";

/**
 * Node-level wiring shared by every `wf.mcp.*` constructor, forwarded to the
 * underlying `wf.op`. MCP ops don't take an AI client (they resolve an MCP
 * session from the transport/pool), so there is no per-op `ai` option here.
 */
export interface MCPNodeOptions {
  /** Node name (also the reasoning-record label). */
  name?: string;
  /** What to do when the op throws. Default `"stop"`. */
  onError?: "stop" | "continue";
}

/**
 * Maps an MCP {@link MCPOutputKind} to the value type {@link MCPNamespace.call}
 * produces when no `parseResponse` hook is given, so the output shape is stated
 * once (as `output`) instead of also as a `<Out>` parameter that can drift.
 * `"json"` has no fixed shape, so it widens to `unknown`.
 */
export type MCPCallNodeResult<K extends MCPOutputKind> = K extends "json"
  ? unknown
  : K extends OutputKind
    ? AIComputeResult<K>
    : never;

/** Options for {@link MCPNamespace.call}: node wiring + MCP call config. */
export interface MCPCallNodeOptions<In, Out>
  extends MCPCallOptions<In, Out>,
    MCPNodeOptions {}

/** Options for {@link MCPNamespace.script}: node wiring + MCP script config. */
export interface MCPScriptNodeOptions<In, Out>
  extends MCPScriptOptions<In, Out>,
    MCPNodeOptions {}

/**
 * The object returned by `wf.mcp`. Each method runs the op's one-time setup
 * (validation + pool prewarm) at construct time, registers the per-run op on the
 * bound workflow, and returns its output node.
 */
export class MCPNamespace {
  constructor(private readonly wf: Workflow) {}

  /** Node-level wiring shared by every constructor. */
  private wiring(opts: MCPNodeOptions | undefined, fallbackName: string) {
    return { name: opts?.name ?? fallbackName, onError: opts?.onError };
  }

  /**
   * Invokes a single MCP server tool as a DAG step. Setup (validate + prewarm)
   * runs now; the call itself runs per-Run with the engine-supplied `ctx`. The
   * output node's value type follows `opts.output` (`output: "number"` →
   * `Node<number>`); a `parseResponse` hook overrides it to its own return type.
   * SECURITY: `input` is marshaled into the tool's arguments — see {@link mcpCall}.
   */
  call<In, Out>(
    input: Node<In>,
    opts: MCPCallNodeOptions<In, Out> & {
      parseResponse: (text: string, structured: unknown) => Out;
    },
  ): Node<Out>;
  call<In, K extends MCPOutputKind = "string">(
    input: Node<In>,
    opts: Omit<MCPCallNodeOptions<In, MCPCallNodeResult<K>>, "parseResponse" | "output"> & {
      output?: K;
    },
  ): Node<MCPCallNodeResult<K>>;
  call<In>(
    input: Node<In>,
    opts: MCPCallNodeOptions<In, unknown>,
  ): Node<unknown> {
    setupMCPCall(opts);
    return this.wf.op(
      { input },
      ({ input }, ctx) => mcpCall(input, opts, ctx),
      this.wiring(opts, "mcpCall"),
    );
  }

  /**
   * Orchestrates a sequence of MCP tool calls over one long-lived session as a
   * DAG step. Setup (validate + prewarm) runs now; the script runs once per Run
   * with the engine-supplied `ctx`. SECURITY: `input` is handed to the script —
   * see {@link mcpScript}.
   */
  script<In, Out>(
    input: Node<In>,
    opts: MCPScriptNodeOptions<In, Out>,
  ): Node<Out> {
    setupMCPScript(opts);
    return this.wf.op(
      { input },
      ({ input }, ctx) => mcpScript(input, opts, ctx),
      this.wiring(opts, "mcpScript"),
    );
  }
}

const namespaces = new WeakMap<Workflow, MCPNamespace>();

declare module "../workflow" {
  interface Workflow {
    /**
     * Node-constructor surface for MCP ops (`wf.mcp.call(node, opts)`,
     * `wf.mcp.script(node, opts)`). Installed by importing the `mcp` package;
     * see {@link MCPNamespace}.
     */
    readonly mcp: MCPNamespace;
  }
}

// One namespace per workflow instance, created lazily and memoized so repeated
// `wf.mcp` reads return the same object.
Object.defineProperty(Workflow.prototype, "mcp", {
  configurable: true,
  get(this: Workflow): MCPNamespace {
    let ns = namespaces.get(this);
    if (!ns) {
      ns = new MCPNamespace(this);
      namespaces.set(this, ns);
    }
    return ns;
  },
});
