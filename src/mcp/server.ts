import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Workflow } from "../workflow";
import { execute } from "../engine";

/** Maps an MCP tool call to a Sparsi workflow execution. */
export interface WorkflowToolConfig {
  /** Description shown to the MCP client. */
  description: string;
  /** The workflow to execute. */
  workflow: Workflow;
  /** Maps MCP tool argument names to workflow context value keys. */
  inputMapping: Record<string, string>;
  /** The name (label) of the node whose value should be returned. Defaults to "final_result". */
  outputWire?: string;
}

/**
 * Exposes Sparsi workflows as tools on an MCP server over stdio.
 * Mirroring the functionality of MCPServer in sparsi-py.
 */
export class MCPServer {
  private readonly server: Server;
  private readonly toolConfigs = new Map<string, WorkflowToolConfig>();

  constructor(name: string, version: string = "0.1.0") {
    this.server = new Server(
      { name, version },
      { capabilities: { tools: {} } }
    );
  }

  /** Registers a workflow as an MCP tool. */
  addWorkflowTool(name: string, config: WorkflowToolConfig): void {
    this.toolConfigs.set(name, config);
  }

  /**
   * Starts the server over stdio. This is a long-lived call that waits for
   * the connection to close.
   */
  async run(): Promise<void> {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.toolConfigs.entries()).map(([name, cfg]) => ({
        name,
        description: cfg.description,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(cfg.inputMapping).map((k) => [k, { type: "string" }])
          ),
          required: Object.keys(cfg.inputMapping),
        },
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const cfg = this.toolConfigs.get(name);
      if (!cfg) throw new Error(`Unknown tool: ${name}`);

      // Map arguments to context values
      const values: Record<string, unknown> = {};
      for (const [argName, ctxKey] of Object.entries(cfg.inputMapping)) {
        values[ctxKey] = (args as any)?.[argName];
      }

      // Execute workflow
      const res = await execute(cfg.workflow, { values });
      
      // Find output by name (outputWire)
      const outputName = cfg.outputWire ?? "final_result";
      const status = res.nodes().find((n) => n.name === outputName);

      if (!status || status.skipped) {
        return {
          content: [{ type: "text", text: `Error: Output node "${outputName}" not found or was skipped.` }],
          isError: true,
        };
      }

      const result = status.value;
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    });

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
