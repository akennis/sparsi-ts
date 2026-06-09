/**
 * AI example — a GitHub README quality reporter.
 *
 * Faithful port of sparsi-go examples/readme-quality/main.go. Given an
 * owner/repo slug (or a fixture file), it fetches the README, truncates it to
 * 8 KB, runs five AI quality probes concurrently (purpose, doc-completeness
 * score, clarity score, has-tests, has-install), computes an average score
 * deterministically, routes through one of three quality lanes (excellent / ok /
 * poor), and appends a "tests not mentioned" warning when has_tests is false.
 *
 * Live mode fetches the README from the main and master branches in parallel and
 * picks whichever returned HTTP 200. The Go `-mcp` stdio-server wrapper is
 * intentionally omitted (§6g: optional); the live fetch / fixture read and the
 * branch pick are resolved here in main(), so the workflow is the analysis DAG.
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY). `--slug` also hits live network.
 *   npm run example:readme                          # bundled dagor.md fixture
 *   npm run example:readme -- --slug golang/go
 *   npm run example:readme -- --fixture examples/testdata/readme/n.md
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

interface Lane {
  name: "excellent" | "ok" | "poor";
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

/** Caps the input to at most MAX_BYTES UTF-8 bytes (Go StringTruncateOp). */
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
  const purpose = wf.op({ readme }, ({ readme }, ctx) =>
    ai.aiCompute<string>(readme, { operation: OP_PURPOSE, output: "string", name: "purpose" }, ctx),
    { name: "purpose_op" });
  const docScore = wf.op({ readme }, ({ readme }, ctx) =>
    ai.aiScore(readme, { criterion: CRIT_DOC }, ctx), { name: "doc_score_op" });
  const clarityScore = wf.op({ readme }, ({ readme }, ctx) =>
    ai.aiScore(readme, { criterion: CRIT_CLARITY }, ctx), { name: "clarity_op" });
  const hasTests = wf.op({ readme }, ({ readme }, ctx) =>
    ai.aiBool(readme, { predicate: PRED_TESTS }, ctx), { name: "has_tests_op" });
  const hasInstall = wf.op({ readme }, ({ readme }, ctx) =>
    ai.aiBool(readme, { predicate: PRED_INSTALL }, ctx), { name: "has_install_op" });

  // Stage 4 — deterministic average score.
  const avgScore = wf.op({ docScore, clarityScore }, ({ docScore, clarityScore }) =>
    ops.num.divFloat(ops.num.addFloat(docScore, clarityScore), 2.0), { name: "avg_score_op" });

  // Stage 5 — three quality lanes (exactly one fires, gated on avg_score).
  const laneNodes = LANES.map((lane) =>
    wf.op({ readme, avgScore }, ({ readme }, ctx) =>
      ai.aiCompute<string>(
        readme,
        { operation: lane.operation, output: "string", name: lane.name },
        ctx,
      ),
      {
        name: `${lane.name}_lane`,
        condition: ({ avgScore }) =>
          lane.name === "excellent"
            ? avgScore >= EXCELLENT_MIN
            : lane.name === "ok"
              ? avgScore >= OK_MIN && avgScore < EXCELLENT_MIN
              : avgScore < OK_MIN,
      }),
  );

  // Stage 6 — coalesce lanes + append optional "tests not mentioned" warning.
  const narrative = wf.coalesce(laneNodes, { name: "narrative_op" });
  const finalNarrative = wf.op({ narrative, hasTests }, ({ narrative, hasTests }) =>
    ops.text.stringConcat(narrative, hasTests ? "" : WARNING), { name: "final_narrative" });

  return { wf, purpose, docScore, clarityScore, avgScore, hasTests, hasInstall, finalNarrative };
}

// ─── Driver ───────────────────────────────────────────────────────────────

interface Args {
  slug?: string;
  fixture?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug") out.slug = argv[++i];
    else if (argv[i] === "--fixture") out.fixture = argv[++i];
  }
  return out;
}

/** Live: fetch README from main + master in parallel, pick whichever is 200. */
async function fetchReadme(slug: string): Promise<string> {
  const mainURL = `https://raw.githubusercontent.com/${slug}/main/README.md`;
  const masterURL = `https://raw.githubusercontent.com/${slug}/master/README.md`;
  const [main, master] = await Promise.all([ops.io.httpGet(mainURL), ops.io.httpGet(masterURL)]);
  return main.statusCode === 200 ? main.body : master.body;
}

function verdictFor(avg: number): "excellent" | "ok" | "poor" {
  if (avg >= EXCELLENT_MIN) return "excellent";
  if (avg >= OK_MIN) return "ok";
  return "poor";
}

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  const { slug, fixture } = parseArgs(process.argv.slice(2));
  if (slug && fixture) {
    console.error("specify exactly one of --slug or --fixture");
    process.exit(2);
  }

  let readmeRaw: string;
  let displaySlug: string;
  if (slug) {
    displaySlug = slug;
    readmeRaw = await fetchReadme(slug);
  } else {
    // --fixture, or the bundled dagor.md default so the example runs with no args.
    const path = fixture ?? join(__dirname, "testdata", "readme", "dagor.md");
    displaySlug = fixture ? fixture : basename(path);
    readmeRaw = readFileSync(path, "utf8");
  }

  const { wf, purpose, docScore, clarityScore, avgScore, hasTests, hasInstall, finalNarrative } =
    build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { readme_raw: readmeRaw },
    concurrency: 10,
  });

  const avg = result.get(avgScore);
  const verdict = verdictFor(avg);
  const laneLabel = `AIComputeStringToStringOp(${verdict})`;

  const out = {
    slug: displaySlug,
    purpose: result.get(purpose),
    doc_score: result.get(docScore),
    clarity_score: result.get(clarityScore),
    avg_score: avg,
    has_tests: result.get(hasTests),
    has_install: result.get(hasInstall),
    verdict,
    narrative: result.get(finalNarrative),
    ai_nodes: [
      "AIComputeStringToStringOp(purpose)",
      "AIScoreOp(doc_score)",
      "AIScoreOp(clarity_score)",
      "AIBoolOp(has_tests)",
      "AIBoolOp(has_install)",
      laneLabel,
    ],
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
