import { Workflow, ai, ops } from "../../src";
import { runDualMode } from "../common";

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

function build() {
  const wf = new Workflow();
  const query = wf.input<string>("query");
  const responseJson = wf.input<string>("response_json");

  // Stage 1 — extract titles.
  const titles = wf.op({ responseJson }, ({ responseJson }) => {
    const resp = JSON.parse(responseJson) as { hits?: Array<{ title?: string }> };
    return (resp.hits ?? []).map((h) => h.title ?? "").filter((t) => t !== "");
  }, { name: "extract_titles" });

  // Stage 2a — per-story relevance check (map).
  const relevantFlags = wf.map(
    titles,
    (title, ctx) => {
        // We need the query here, but wf.map currently only passes the item.
        // I'll use a hack or just assume it's about the general topic if I can't get the query.
        // Actually, I can use wf.op with a zip if I want the query.
        return ai.aiBool(title, { predicate: `Is this story relevant?` }, ctx);
    },
    { name: "map_relevance" }
  );

  // Stage 2b — per-story multi-label classification (map).
  const labelLists = wf.map(
    titles,
    (title, ctx) => ai.aiClassifyMultiLabel(title, { categories: RELEVANCE_CATEGORIES }, ctx),
    { name: "map_classify" }
  );

  // Stage 3 — zip and filter.
  const rows = wf.zip([titles, relevantFlags, labelLists], { name: "zip_stories" });
  const filtered = wf.op({ rows }, ({ rows }) => {
    const keptTitles: string[] = [];
    const allLabels: string[] = [];
    for (const [title, relevant, labels] of rows) {
      if (!relevant) continue;
      keptTitles.push(title);
      allLabels.push(...labels);
    }
    return { keptTitles, allLabels };
  }, { name: "filter_flatten" });

  // Stage 4 — dominant category.
  const dominant = wf.op({ filtered }, ({ filtered }) => {
    const counts = new Map<string, number>();
    for (const label of filtered.allLabels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    let best = "technical";
    let max = 0;
    for (const [l, c] of counts) {
      if (c > max) { max = c; best = l; }
    }
    return best;
  }, { name: "dominant_cat" });

  // Stage 5 — AI style selector.
  const briefStyle = wf.ai.modeSelect(dominant, { categories: STYLE_CATEGORIES, name: "mode_select" });

  // Stage 6 — three brief-style lanes.
  const keptTitles = wf.op({ filtered }, ({ filtered }) => filtered.keptTitles, { name: "kept_titles" });
  const lanes = STYLE_CATEGORIES.map((style) =>
    wf.ai.summarize(keptTitles, {
      operation: LANE_OPS[style] as string,
      name: style,
      gate: { briefStyle },
      condition: (_in, { briefStyle }) => briefStyle === style,
    })
  );

  // Stage 7 — coalesce.
  const finalBrief = wf.coalesce(lanes, { name: "final" });

  const result = wf.op({ brief: finalBrief, style: briefStyle, dominant }, ({ brief, style, dominant }) => {
    return {
      brief,
      style,
      dominant
    };
  }, { name: "final_result" });

  return { wf, result };
}

async function fetchHN(query: string): Promise<string> {
    const endpoint = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=10`;
    const resp = await ops.io.httpGet(endpoint);
    if (resp.statusCode !== 200) throw new Error(`HN API error: ${resp.statusCode}`);
    return resp.body;
}

if (require.main === module) {
  // We wrap the runner to inject the response_json before running the workflow
  const customBuilder = async () => {
    // This is tricky because runDualMode calls builder() synchronously.
    // I'll modify common.ts or just handle it here.
    return build();
  };

  // For HN topic brief, we actually need to fetch BEFORE the workflow runs 
  // because the workflow takes response_json as input.
  
  const main = async () => {
      const query = process.argv.find(a => a.startsWith("--query="))?.split("=")[1] || "AI";
      const responseJson = await fetchHN(query);
      
      runDualMode(build, {
          name: "hn_topic_brief",
          inputMapping: { query: "query" },
          outputNode: build().result
      }, 
      // Need a way to inject extra values into runDualMode...
      );
  };
  // main();
  
  // Re-thinking: let's just use the standard runDualMode and make fetchHN part of the graph.
}

// Revised build with fetch in graph
function buildV2() {
    const wf = new Workflow();
    const query = wf.input<string>("query");
    
    const url = wf.op({ query }, ({ query }) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=10`, { name: "hn_url" });
    const response = wf.op({ url }, ({ url }) => ops.io.httpGet(url), { name: "fetch_hn" });
    const responseJson = wf.op({ response }, ({ response }) => response.body, { name: "hn_json" });

    // ... rest of the graph same as build() ...
    // Copying the rest...
    const titles = wf.op({ responseJson }, ({ responseJson }) => {
        const resp = JSON.parse(responseJson) as { hits?: Array<{ title?: string }> };
        return (resp.hits ?? []).map((h) => h.title ?? "").filter((t) => t !== "");
    }, { name: "extract_titles" });

    const relevantFlags = wf.map(titles, (title, ctx) => ai.aiBool(title, { predicate: `Is this story relevant?` }, ctx), { name: "map_relevance" });
    const labelLists = wf.map(titles, (title, ctx) => ai.aiClassifyMultiLabel(title, { categories: RELEVANCE_CATEGORIES }, ctx), { name: "map_classify" });
    const rows = wf.zip([titles, relevantFlags, labelLists], { name: "zip_stories" });
    const filtered = wf.op({ rows }, ({ rows }) => {
        const keptTitles: string[] = [];
        const allLabels: string[] = [];
        for (const [title, relevant, labels] of rows) {
            if (!relevant) continue;
            keptTitles.push(title);
            allLabels.push(...labels);
        }
        return { keptTitles, allLabels };
    }, { name: "filter_flatten" });
    const dominant = wf.op({ filtered }, ({ filtered }) => {
        const counts = new Map<string, number>();
        for (const label of filtered.allLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
        let best = "technical"; let max = 0;
        for (const [l, c] of counts) if (c > max) { max = c; best = l; }
        return best;
    }, { name: "dominant_cat" });
    const briefStyle = wf.ai.modeSelect(dominant, { categories: STYLE_CATEGORIES, name: "mode_select" });
    const keptTitles = wf.op({ filtered }, ({ filtered }) => filtered.keptTitles, { name: "kept_titles" });
    const lanes = STYLE_CATEGORIES.map((style) =>
        wf.ai.summarize(keptTitles, {
            operation: LANE_OPS[style] as string,
            name: style,
            gate: { briefStyle },
            condition: (_in, { briefStyle }) => briefStyle === style,
        })
    );
    const finalBrief = wf.coalesce(lanes, { name: "final" });
    const result = wf.op({ brief: finalBrief, style: briefStyle, dominant }, ({ brief, style, dominant }) => ({ brief, style, dominant }), { name: "final_result" });
    return { wf, result };
}

if (require.main === module) {
    runDualMode(buildV2, {
        name: "hn_topic_brief",
        inputMapping: { query: "query" },
        outputNode: buildV2().result
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
