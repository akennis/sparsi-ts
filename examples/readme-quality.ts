/**
 * AI example — a GitHub README quality reporter.
 *
 * Given an owner/repo slug (or a fixture file), it fetches the README, truncates
 * it to 8 KB, runs five AI quality probes concurrently (purpose, doc-completeness
 * score, clarity score, has-tests, has-install), computes an average score
 * deterministically, derives one quality band (excellent / ok / poor) that both
 * gates the narrative lanes and is reported to the caller, and appends a "tests
 * not mentioned" warning when has_tests is false.
 *
 * Live mode fetches the README from the main and master branches in parallel and
 * picks whichever returned HTTP 200. The live fetch / fixture read and the branch
 * pick are resolved here in main(), so the workflow is the analysis DAG.
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY). `--slug` also hits live network.
 *   npm run example:readme                          # bundled sample-readme.md fixture
 *   npm run example:readme -- --slug golang/go
 *   npm run example:readme -- --fixture examples/testdata/readme/n.md
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { Workflow, ai, ops } from "../src";

const MAX_BYTES = 8192;
const EXCELLENT_MIN = 0.75;
const OK_MIN = 0.4;
const WARNING = "\n\nWARNING: tests not mentioned";

const OP_PURPOSE = "summarize the purpose of this project in one concise sentence";
const CRIT_DOC = "documentation completeness";
const CRIT_CLARITY = "clarity for new contributors";
const PRED_TESTS = "does this README mention tests, CI, or automated checks?";
const PRED_INSTALL = "does this README contain installation or usage instructions?";

type Verdict = "excellent" | "ok" | "poor";

interface Lane {
  name: Verdict;
  operation: string;
}

const LANES: Lane[] = [
  {
    name: "excellent",
    operation:
      "write a one-paragraph endorsement of this README, " +
      "highlighting what makes it exemplary for open-source projects",
  },
  {
    name: "ok",
    operation:
      "write a one-paragraph constructive critique of this README " +
      "with 2 specific, actionable suggestions for improvement",
  },
  {
    name: "poor",
    operation:
      "write a one-paragraph improvement plan for this README " +
      "listing the 3 highest-impact fixes that would help new contributors",
  },
];

/** The single source of truth for the excellent/ok/poor banding (Finding K). */
function verdictFor(avg: number): Verdict {
  if (avg >= EXCELLENT_MIN) return "excellent";
  if (avg >= OK_MIN) return "ok";
  return "poor";
}

/**
 * Caps the input to at most MAX_BYTES UTF-8 bytes.
 *
 * If the cut at MAX_BYTES lands mid-rune, the trailing partial UTF-8 sequence
 * decodes to U+FFFD here (a JS string cannot hold the raw, invalid bytes that a
 * byte-oriented truncation would leave behind). The bundled sample-readme.md fixture is
 * well under the cap, so this only affects inputs larger than MAX_BYTES whose
 * boundary byte splits a multi-byte character.
 */
function truncate(s: string): string {
  const buf = Buffer.from(s, "utf8");
  return buf.length > MAX_BYTES ? buf.subarray(0, MAX_BYTES).toString("utf8") : s;
}

function build() {
  const wf = new Workflow();
  const readmeRaw = wf.input<string>("readme_raw");

  // Stage 2 — truncate to 8 KB.
  const readme = wf.op({ readmeRaw }, ({ readmeRaw }) => truncate(readmeRaw), { name: "truncate" });

  // Stage 3 — five parallel AI probes.
  const purpose = wf.ai.compute(readme, { operation: OP_PURPOSE, output: "string", name: "purpose" });
  const docScore = wf.ai.score(readme, { criterion: CRIT_DOC, name: "doc_score" });
  const clarityScore = wf.ai.score(readme, { criterion: CRIT_CLARITY, name: "clarity_score" });
  const hasTests = wf.ai.bool(readme, { predicate: PRED_TESTS, name: "has_tests" });
  const hasInstall = wf.ai.bool(readme, { predicate: PRED_INSTALL, name: "has_install" });

  // Stage 4 — deterministic average score, then the single derived quality band.
  const avgScore = wf.op({ docScore, clarityScore }, ({ docScore, clarityScore }) =>
    ops.num.div(ops.num.add(docScore, clarityScore), 2.0), { name: "avg_score" });
  // The band is computed once, here, and shared: the lanes gate on it and the
  // driver reports it, so the threshold logic isn't re-derived (Finding K).
  const band = wf.op({ avgScore }, ({ avgScore }) => verdictFor(avgScore), { name: "verdict" });

  // Stage 5 — three quality lanes (exactly one fires, gated on the band). The
  // band rides `gate`, so each lane's predicate selects on it without it being
  // wired into the AI input (which is just the README) — no passthrough op.
  const laneNodes = LANES.map((lane) =>
    wf.ai.compute(readme, {
      operation: lane.operation,
      output: "string",
      name: `${lane.name}_lane`,
      gate: { band },
      condition: (_in, { band }) => band === lane.name,
    }),
  );

  // Stage 6 — coalesce lanes + append optional "tests not mentioned" warning.
  const narrative = wf.coalesce(laneNodes, { name: "narrative" });
  const finalNarrative = wf.op({ narrative, hasTests }, ({ narrative, hasTests }) =>
    ops.text.stringConcat(narrative, hasTests ? "" : WARNING), { name: "final_narrative" });

  // The AI vertices, by reference — the driver reads which fired off each node's
  // own `name`/skip status instead of a parallel label array (Finding E).
  const aiVertices = [purpose, docScore, clarityScore, hasTests, hasInstall, ...laneNodes];

  return { wf, purpose, docScore, clarityScore, avgScore, band, hasTests, hasInstall, finalNarrative, aiVertices };
}

// ─── Driver ───────────────────────────────────────────────────────────────

/** Live: fetch README from main + master in parallel, pick whichever is 200. */
async function fetchReadme(slug: string): Promise<string> {
  const mainURL = `https://raw.githubusercontent.com/${slug}/main/README.md`;
  const masterURL = `https://raw.githubusercontent.com/${slug}/master/README.md`;
  const [main, master] = await Promise.all([ops.io.httpGet(mainURL), ops.io.httpGet(masterURL)]);
  return main.statusCode === 200 ? main.body : master.body;
}

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { slug: { type: "string" }, fixture: { type: "string" } },
  });
  if (values.slug && values.fixture) {
    console.error("specify exactly one of --slug or --fixture");
    process.exit(2);
  }

  let readmeRaw: string;
  let displaySlug: string;
  if (values.slug) {
    displaySlug = values.slug;
    readmeRaw = await fetchReadme(values.slug);
  } else {
    // --fixture, or the bundled default so the example runs with no args.
    const path = values.fixture ?? join(__dirname, "testdata", "readme", "sample-readme.md");
    displaySlug = values.fixture ? values.fixture : basename(path);
    readmeRaw = readFileSync(path, "utf8");
  }

  const {
    wf,
    purpose,
    docScore,
    clarityScore,
    avgScore,
    band,
    hasTests,
    hasInstall,
    finalNarrative,
    aiVertices,
  } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { readme_raw: readmeRaw },
    concurrency: 10,
  });

  const out = {
    slug: displaySlug,
    purpose: result.get(purpose),
    doc_score: result.get(docScore),
    clarity_score: result.get(clarityScore),
    avg_score: result.get(avgScore),
    has_tests: result.get(hasTests),
    has_install: result.get(hasInstall),
    verdict: result.get(band),
    narrative: result.get(finalNarrative),
    ai_nodes: aiVertices.filter((n) => !result.skipped(n)).map((n) => n.name),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
