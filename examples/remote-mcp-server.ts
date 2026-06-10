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
import { Workflow, mcp } from "../src";

const CF_URL = "https://docs.mcp.cloudflare.com/mcp";
const CF_TOOL = "search_cloudflare_documentation";

/** The typed argument shape passed to the search tool (aligns with its schema). */
interface SearchInput {
  query: string;
}

function build() {
  const wf = new Workflow();
  const query = wf.input<string>("query");

  const searchResults = wf.op({ query }, ({ query }, ctx) =>
    mcp.mcpCall<SearchInput, string>(
      { query },
      {
        transport: "http",
        url: CF_URL,
        tool: CF_TOOL,
        output: "string",
        initTimeoutMs: 30000,
        callTimeoutMs: 60000,
        maxRetries: 2,
        // For a private server: headers: { Authorization: `Bearer ${process.env.TOKEN}` },
      },
      ctx,
    ),
    { name: "cf_search" });

  return { wf, searchResults };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

function parseQuery(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--query") return argv[++i];
  }
  return undefined;
}

async function main() {
  const parsedQuery = parseQuery(process.argv.slice(2));
  // Default query so the example runs with no args.
  const query =
    parsedQuery?.trim() ? parsedQuery : "How do I configure a Worker route?";

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
