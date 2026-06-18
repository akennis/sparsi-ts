import { parseArgs } from "node:util";
import { Workflow, RunResult, NodeStatus } from "../src";

export interface DualModeOptions {
  name: string;
  version?: string;
  inputMapping: Record<string, string>;
  outputNode: any; // Node<any>
}

/**
 * Prints a summary of the workflow run, similar to the Go/Python Reporters.
 */
export function printReport(result: RunResult, verbose: boolean) {
  if (!verbose) return;

  console.error("\n--- Workflow Execution Report ---");
  for (const node of result.nodes()) {
    const status = node.skipped ? "\x1b[33mSKIP\x1b[0m" : "\x1b[32mFIRE\x1b[0m";
    console.error(`[${status}] ${node.name} (${node.kind})`);
    if (!node.skipped && node.value !== undefined) {
      const valStr = typeof node.value === "string" ? node.value : JSON.stringify(node.value);
      const truncated = valStr.length > 100 ? valStr.slice(0, 100) + "..." : valStr;
      console.error(`      out: ${truncated}`);
    }
  }
  console.error("---------------------------------\n");
}

/**
 * Helper for running examples in CLI or MCP mode.
 */
export async function runDualMode(
  builder: () => { wf: Workflow; [key: string]: any },
  options: DualModeOptions
) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mcp: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      // Dynamically add input mapping keys
      ...Object.fromEntries(
        Object.keys(options.inputMapping).map((k) => [k, { type: "string" }])
      ),
    },
    strict: false,
  });

  if (values.mcp) {
    const { MCPServer } = await import("../src/mcp/server");
    const server = new MCPServer(options.name, options.version ?? "1.0.0");
    const { wf } = builder();
    
    server.addWorkflowTool(options.name, {
      description: `Executes the ${options.name} workflow`,
      workflow: wf,
      inputMapping: options.inputMapping,
      outputWire: options.outputNode.name,
    });

    console.error(`Starting ${options.name} MCP server...`);
    await server.run();
  } else {
    // CLI Mode
    const inputs: Record<string, any> = {};
    for (const [arg, contextKey] of Object.entries(options.inputMapping)) {
      const val = values[arg];
      if (val === undefined) {
        console.error(`Error: --${arg} is required in CLI mode.`);
        process.exit(1);
      }
      inputs[contextKey] = val;
    }

    const { wf } = builder();
    
    let defaultAi: any;
    try {
        const { ai } = await import("../src");
        defaultAi = new ai.GeminiClient();
    } catch {}

    const result = await wf.run({
      ai: defaultAi,
      values: inputs,
      concurrency: 10,
    });

    if (values.verbose) {
      printReport(result, true);
    }

    const output = result.get(options.outputNode);
    console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2));
  }
}
