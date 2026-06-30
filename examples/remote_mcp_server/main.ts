import { Workflow, mcp } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const query = wf.input<string>("query");

  const searchResults = wf.mcp.call(wf.op({ query }, ({ query }) => ({ query }), { name: "prepare_args" }), {
    transport: "http",
    url: "https://docs.mcp.cloudflare.com/mcp",
    tool: "search_cloudflare_documentation",
    name: "cf_search"
  });

  const result = wf.op({ query, searchResults }, ({ query, searchResults }) => {
    return {
      query,
      results: searchResults
    };
  }, { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  runDualMode(build, {
    name: "remote_mcp_server",
    inputMapping: { query: "query" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
