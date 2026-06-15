/**
 * MCP example — sparsi's remote (HTTP) MCP transport against a public server.
 *
 * It queries the public Cloudflare docs MCP server at
 * https://docs.mcp.cloudflare.com/mcp,
 * which exposes the `search_cloudflare_documentation` tool over streamable HTTP.
 * No subprocess, no API keys.
 *
 *   query ─► cf_search ─► search_results (string)
 *           (MCPCallOp, transport=http,
 *            url=https://docs.mcp.cloudflare.com/mcp,
 *            tool=search_cloudflare_documentation)
 *
 * Reference: https://github.com/cloudflare/mcp-server-cloudflare/tree/main/apps/docs-vectorize
 *
 * A clean CLI entry point: the search query is the workflow input.
 *
 * For private/authenticated remote MCP servers, add a Bearer token (or any other
 * static header) via the `headers` option — they are injected into every request
 * without overwriting protocol headers. The Cloudflare docs endpoint is public,
 * so the example leaves `headers` unset.
 *
 * Prerequisites:
 *   - Network access to docs.mcp.cloudflare.com.
 *   - No CLAUDE_API_KEY required.
 *     npm run example:remote-mcp                                  # default query
 *     npm run example:remote-mcp -- --query "How do I configure a Worker route?"
 */
import { parseArgs } from "node:util";
// Importing from `../src` (which re-exports `mcp`) installs the `wf.mcp.*`
// node-constructor surface on Workflow.
import { Workflow } from "../src";

const CF_URL = "https://docs.mcp.cloudflare.com/mcp";
const CF_TOOL = "search_cloudflare_documentation";

function build() {
  const wf = new Workflow();
  const query = wf.input<string>("query");

  // Node in, node out: the engine supplies `ctx`, setup/validation runs at build
  // time, and `output: "string"` infers the node's value type (`Node<string>`).
  // `formatArgs` shapes the scalar query node into the tool's argument record.
  const searchResults = wf.mcp.call<string>(query, {
    transport: "http",
    url: CF_URL,
    tool: CF_TOOL,
    output: "string",
    formatArgs: (query) => ({ query }),
    initTimeoutMs: 30000,
    callTimeoutMs: 60000,
    maxRetries: 2,
    name: "cf_search",
    // For a private server: headers: { Authorization: `Bearer ${process.env.TOKEN}` },
  });

  return { wf, searchResults };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { query: { type: "string" } },
  });
  // Default query so the example runs with no args.
  const query = values.query?.trim() ? values.query : "How do I configure a Worker route?";

  const { wf, searchResults } = build();
  const result = await wf.run({ values: { query } });
  const results = result.get(searchResults);

  // Human-readable header on stderr; raw tool result on stdout.
  process.stderr.write(`query: ${JSON.stringify(query)}\n--- result ---\n`);
  console.log(results);
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
