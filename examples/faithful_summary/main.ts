import { readFileSync } from "node:fs";
import { Workflow, ai } from "../../src";
import { runDualMode } from "../common";

const CLAUDE_MODEL = "gemini-3.1-flash-lite"; // Swapped to gemini for the example environment
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

function build() {
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
    ai: new ai.GeminiClient({ model: GEMINI_MODEL }),
  });

  const finalResult = wf.op({ summary, faithful, source }, ({ summary, faithful, source }) => {
    return {
      source_length: Buffer.byteLength(source, "utf8"),
      summary,
      faithful
    };
  }, { name: "final_result" });

  return { wf, finalResult };
}

if (require.main === module) {
  runDualMode(build, {
    name: "faithful_summary",
    inputMapping: { text: "source" },
    outputNode: build().finalResult
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
