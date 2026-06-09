/**
 * AI example — mirrors the Go ticket-triager.
 *
 * Classifies a support ticket into one of four lanes, runs a different AI
 * extraction per lane (in parallel — only the matching lane's condition fires),
 * then coalesces the single lane that ran into a final brief. The "other" lane
 * deliberately fails the run.
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY).
 *   npm run example:ticket -- "I was double charged on invoice 4471"
 */
import { Workflow, ai } from "../src";

const CATEGORIES = ["billing", "bug", "feature", "other"];

function build() {
  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");

  const cls = wf.op({ ticket }, ({ ticket }, ctx) =>
    ai.modeSelect(ticket, { categories: CATEGORIES }, ctx),
  );

  const billing = wf.op(
    { cls, ticket },
    async ({ ticket }, ctx) => {
      const fields = await ai.aiExtractMap(
        ticket,
        { operation: "extract account_id, amount, and issue from this billing ticket" },
        ctx,
      );
      return `BILLING — ${JSON.stringify(fields)}`;
    },
    { name: "billing", condition: ({ cls }) => cls === "billing" },
  );

  const bug = wf.op(
    { cls, ticket },
    async ({ ticket }, ctx) => {
      const steps = await ai.aiExtractStringSlice(
        ticket,
        { operation: "extract the reproduction steps as a list" },
        ctx,
      );
      return `BUG — steps: ${steps.join(" | ")}`;
    },
    { name: "bug", condition: ({ cls }) => cls === "bug" },
  );

  const feature = wf.op(
    { cls, ticket },
    async ({ ticket }, ctx) => {
      const summary = await ai.aiSummarize(
        [ticket],
        { operation: "summarize this feature request in one concise sentence" },
        ctx,
      );
      return `FEATURE — ${summary}`;
    },
    { name: "feature", condition: ({ cls }) => cls === "feature" },
  );

  // The "other" lane fails the run, matching the Go example.
  const other = wf.op(
    { cls },
    (): string => {
      throw new Error("ticket could not be triaged into a known lane");
    },
    { name: "other", condition: ({ cls }) => cls === "other" },
  );

  const brief = wf.coalesce([billing, bug, feature, other], { name: "brief" });
  return { wf, cls, brief };
}

async function main() {
  const ticketText =
    process.argv.slice(2).join(" ") ||
    "I was charged twice for my subscription this month on account 88231. Please refund the duplicate $29.99 charge.";

  const { wf, cls, brief } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    reasoning: true,
    values: { ticket: ticketText },
  });

  console.log("category:", result.get(cls));
  console.log("brief:   ", result.get(brief));
  if (result.reasoning.length > 0) {
    console.log("\nreasoning:");
    for (const r of result.reasoning) console.log(`  [${r.node}] ${r.reasoning}`);
  }
}

main().catch((err) => {
  console.error("run failed:", err.message);
  process.exit(1);
});
