/**
 * AI example — a HackerNews topic-brief generator.
 *
 * Given a search query, it fetches the top HN stories (Algolia API), fans out
 * per-story AI checks over a map node (relevance filter + multi-label classifier),
 * computes the dominant category deterministically, selects a brief style via
 * modeSelect, and produces a structured brief in one of three styles (technical /
 * business / policy) — exactly one lane fires, merged by coalesce.
 *
 * The `--cache` / `--fixture` offline conveniences are kept; the live fetch /
 * fixture read is resolved here in main(), so the workflow is the pure analysis
 * DAG (the per-story query is closed over by build()).
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY). `--query` without `--cache`
 * also hits live network.
 *   npm run example:hn                       # cached "golang" fixture
 *   npm run example:hn -- --query golang --cache
 *   npm run example:hn -- --query "EU AI Act"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Workflow, ai, ops } from "../src";

const RELEVANCE_CATEGORIES = ["technical", "business", "policy", "human_interest", "other"];
const STYLE_CATEGORIES = ["technical_brief", "business_brief", "policy_brief"];

const LANE_OPS: Record<string, string> = {
  technical_brief:
    "summarize the following HackerNews story titles as a technical engineering newsletter: " +
    "write one concise bullet point per story and group related stories by sub-topic",
  business_brief:
    "summarize the following HackerNews story titles as an executive business brief: " +
    "write a 3-sentence overview then a bulleted impact list",
  policy_brief:
    "summarize the following HackerNews story titles as a policy memo: " +
    "list legislative items, affected parties, and likely timeline",
};

/** Parses the HN Algolia response and returns non-empty hit titles. */
function extractTitles(json: string): string[] {
  const resp = JSON.parse(json) as { hits?: Array<{ title?: string }> };
  const hits = resp.hits ?? [];
  return hits.map((h) => h.title ?? "").filter((t) => t !== "");
}

/** Most frequent label; ties broken alphabetically; "technical" when empty. */
function dominantCategory(allLabels: string[]): string {
  const counts = new Map<string, number>();
  for (const raw of allLabels) {
    const label = raw.trim();
    if (label !== "") counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best = "technical";
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount || (count === bestCount && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

function build(query: string) {
  const wf = new Workflow();
  const responseJson = wf.input<string>("response_json");

  // Stage 1 — extract titles.
  const titles = wf.op({ responseJson }, ({ responseJson }) => extractTitles(responseJson), {
    name: "extract_titles",
  });

  // Stage 2a — per-story relevance check (map). The query shapes the predicate.
  const relevantFlags = wf.map(
    titles,
    (title, ctx) =>
      ai.aiBool(
        title,
        {
          predicate: `Is this HackerNews story title actually about the topic ${JSON.stringify(
            query,
          )}? Respond true or false.`,
        },
        ctx,
      ),
    { name: "map_relevance" },
  );

  // Stage 2b — per-story multi-label classification (map).
  const labelLists = wf.map(
    titles,
    (title, ctx) => ai.aiClassifyMultiLabel(title, { categories: RELEVANCE_CATEGORIES }, ctx),
    { name: "map_classify" },
  );

  // Stage 3 — zip the three parallel maps back into correlated rows (no
  // positional indexing, no casts, no length guard — Finding H), then filter by
  // relevance and flatten the kept labels.
  const rows = wf.zip([titles, relevantFlags, labelLists], { name: "zip_stories" });
  const filtered = wf.op(
    { rows },
    ({ rows }) => {
      const keptTitles: string[] = [];
      const allLabels: string[] = [];
      for (const [title, relevant, labels] of rows) {
        if (!relevant) continue;
        keptTitles.push(title);
        allLabels.push(...labels);
      }
      return { keptTitles, allLabels };
    },
    { name: "filter_flatten" },
  );

  // Stage 4 — dominant category.
  const dominant = wf.op({ filtered }, ({ filtered }) => dominantCategory(filtered.allLabels), {
    name: "dominant_cat",
  });

  // Stage 5 — AI style selector.
  const briefStyle = wf.ai.modeSelect(dominant, { categories: STYLE_CATEGORIES, name: "mode_select" });

  // Stage 6 — three brief-style lanes (exactly one fires). The selected style
  // rides `gate`, so each lane's predicate selects on it without it being wired
  // into the AI input (which is just the kept titles) — no passthrough op.
  const keptTitles = wf.op({ filtered }, ({ filtered }) => filtered.keptTitles, {
    name: "kept_titles",
  });
  const lanes = STYLE_CATEGORIES.map((style) =>
    wf.ai.summarize(keptTitles, {
      operation: LANE_OPS[style] as string,
      name: style,
      gate: { briefStyle },
      condition: (_in, { briefStyle }) => briefStyle === style,
    }),
  );

  // Stage 7 — coalesce the one lane that fired.
  const finalBrief = wf.coalesce(lanes, { name: "final" });

  // The AI-node subset the driver reports on (names come from each node's own
  // `name`/skip status, not a parallel label array). It's needed to *restrict*
  // the fired-node report to AI nodes — `RunResult.firedNodes()` would also
  // include the non-AI plumbing.
  const aiVertices = [relevantFlags, labelLists, briefStyle, ...lanes];

  return { wf, titles, filtered, dominant, briefStyle, finalBrief, aiVertices };
}

// ─── Driver ───────────────────────────────────────────────────────────────

function queryToSlug(query: string): string {
  return query
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

async function fetchOrLoad(query: string, useCache: boolean, fixture?: string): Promise<string> {
  if (fixture) return readFileSync(fixture, "utf8");
  if (useCache) {
    const path = join(__dirname, "testdata", "hn", queryToSlug(query) + ".json");
    return readFileSync(path, "utf8");
  }
  const endpoint =
    "https://hn.algolia.com/api/v1/search?query=" + encodeURIComponent(query) + "&hitsPerPage=10";
  const resp = await ops.io.httpGet(endpoint);
  if (resp.statusCode !== 200) throw new Error(`http status ${resp.statusCode}`);
  return resp.body;
}

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      query: { type: "string" },
      cache: { type: "boolean" },
      fixture: { type: "string" },
    },
  });
  // Default to the cached "golang" fixture so the example runs with no flags.
  const query = values.query ?? "golang";
  const useCache = Boolean(values.cache) || (!values.query && !values.fixture);

  const responseJson = await fetchOrLoad(query, useCache, values.fixture);

  const { wf, titles, filtered, dominant, briefStyle, finalBrief, aiVertices } = build(query);
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { response_json: responseJson },
    concurrency: 10,
  });

  const allTitles = result.get(titles);
  const flat = result.get(filtered);

  const labelDistribution: Record<string, number> = {};
  for (const label of flat.allLabels) {
    if (label !== "") labelDistribution[label] = (labelDistribution[label] ?? 0) + 1;
  }

  const out = {
    query,
    story_count: allTitles.length,
    kept_after_filter: flat.keptTitles.length,
    label_distribution: labelDistribution,
    dominant: result.get(dominant),
    brief_style: result.get(briefStyle),
    brief: result.get(finalBrief),
    ai_nodes: aiVertices.filter((n) => !result.skipped(n)).map((n) => n.name),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
