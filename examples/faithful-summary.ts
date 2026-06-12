/**
 * AI example — mixing Claude and Gemini in a single workflow for a
 * summarization-faithfulness check.
 *
 * Claude produces a 3–5 sentence summary of a source document; a deterministic
 * formatting op assembles the source + summary into one verification prompt;
 * Gemini then checks whether every factual claim in the summary is grounded in the
 * source, returning a boolean verdict. Using a second, independent model to verify
 * is more likely to surface unsupported claims than re-asking the model that wrote
 * the summary.
 *
 * The provider for an AI op is selected per node via the `ai` option: Claude is
 * the run-wide default, and the verify op overrides it with a Gemini client —
 * no run-context surgery.
 *
 * When neither --file nor --text is given, this falls back to a built-in SAMPLE so
 * it runs with no args. `source_length` is the UTF-8 byte length of the source.
 *
 * Requires BOTH CLAUDE_API_KEY (or ANTHROPIC_API_KEY) and GEMINI_API_KEY.
 *   npm run example:faithful -- --text "..."
 *   npm run example:faithful -- --file path/to/article.txt
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Workflow, ai, type AIClient } from "../src";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const GEMINI_MODEL = "gemini-3.1-flash-lite";

const OP_SUMMARIZE =
  "summarize this article in 3–5 concise sentences; include only information explicitly stated in the text, do not add context or draw inferences";
const PRED_FAITHFUL =
  "does every factual claim in the summary appear in or follow directly from the source document, with no information added or invented?";

const SAMPLE = `The James Webb Space Telescope, launched in December 2021, observes
the universe primarily in the infrared. Its 6.5-metre segmented gold-coated
beryllium mirror gathers about six times more light than Hubble's. Because warm
objects glow in the infrared, Webb's instruments are kept near 40 kelvin behind a
tennis-court-sized sunshield. The observatory orbits the Sun at the second
Sun–Earth Lagrange point, roughly 1.5 million kilometres from Earth.`;

function build(gemini: AIClient) {
  const wf = new Workflow();
  const source = wf.input<string>("source");

  // Claude writes the summary (run-wide default client).
  const summary = wf.ai.compute(source, {
    operation: OP_SUMMARIZE,
    output: "string",
    name: "summarize",
    model: CLAUDE_MODEL,
  });

  // Deterministic prompt assembly.
  const query = wf.op({ source, summary }, ({ source, summary }) =>
    `Source document:\n${source}\n\nSummary to verify:\n${summary}`, { name: "format_check" });

  // Gemini independently fact-checks — same op, selected per node via `ai`.
  const faithful = wf.ai.bool(query, {
    predicate: PRED_FAITHFUL,
    model: GEMINI_MODEL,
    name: "verify",
    ai: gemini,
  });

  return { wf, summary, faithful };
}

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required");
    process.exit(1);
  }

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { file: { type: "string" }, text: { type: "string" } },
  });
  let source: string;
  if (values.file) source = readFileSync(values.file, "utf8");
  else if (values.text) source = values.text;
  else source = SAMPLE; // built-in sample so the example runs with no args

  const gemini = new ai.GeminiClient({ model: GEMINI_MODEL });
  const { wf, summary, faithful } = build(gemini);
  const result = await wf.run({
    ai: new ai.AnthropicClient({ model: CLAUDE_MODEL }),
    values: { source },
    concurrency: 10,
  });

  const out = {
    source_length: Buffer.byteLength(source, "utf8"),
    summary: result.get(summary),
    faithful: result.get(faithful),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
