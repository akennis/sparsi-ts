import { Workflow } from "../src/workflow";
import { MCPServer } from "../src/mcp/server";

async function main() {
  const wf = new Workflow();
  const input = wf.input("query");
  wf.const("Hello from Sparsi!", { name: "final_result" });

  const server = new MCPServer("sparsi-example-server", "1.0.0");
  
  server.addWorkflowTool("hello_sparsi", {
    description: "A simple tool that greets the user.",
    workflow: wf,
    inputMapping: { "name": "query" },
    outputWire: "final_result"
  });

  console.error("Starting Sparsi MCP Server on stdio...");
  await server.run();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Server failed:", err);
    process.exit(1);
  });
}
