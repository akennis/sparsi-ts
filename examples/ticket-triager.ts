/**
 * AI example — a customer-support ticket triager.
 *
 * It reads a free-text ticket (from a file via --ticket or inline via
 * --ticket-text),
 * classifies it via modeSelect into one of {billing, bug, feature, other}, and
 * routes the ticket through a category-specific extraction lane. The billing,
 * bug, and feature lanes are DAG branches gated on the classification; only the
 * matching lane fires, and its per-lane JSON summary coalesces into a final
 * brief. Tickets that classify as "other" are intentionally unsupported: the
 * "other" lane fails the run instead of producing a brief.
 *
 * AIClientFactory demo. Every AI vertex resolves its client through a custom
 * factory (CostCenterFactory below) keyed on a "cost center" ref (triage,
 * billing, bug, feature). The factory maps the ref onto an env var
 * (CLAUDE_API_KEY_<COSTCENTER>) so each team can be billed on its own API key,
 * falling back to CLAUDE_API_KEY when the per-cost-center key is unset so the
 * demo still runs with the default single-key setup. Because the AI ops read
 * their client from the run context, each lane passes a context whose client was
 * resolved for that lane's cost center.
 *
 * Env vars keep the example self-contained. A production factory would resolve
 * the ref against a real credential store — AWS Secrets Manager, GCP Secret
 * Manager, HashiCorp Vault, Azure Key Vault, a KMS-decrypted blob, etc. — instead
 * of reading the process environment.
 *
 * Requires CLAUDE_API_KEY (or per-cost-center CLAUDE_API_KEY_<COSTCENTER>). With
 * no args it triages a built-in billing ticket.
 *   npm run example:ticket                                  # built-in billing ticket
 *   npm run example:ticket -- --ticket-text "I was double charged on invoice 4471"
 *   npm run example:ticket -- --ticket path/to/ticket.txt
 */
import { readFileSync } from "node:fs";
import { Workflow, ai } from "../src";
import type { AIClient, RunContext, ReasoningEntry } from "../src";

const CATEGORIES = ["billing", "bug", "feature", "other"];

// Default ticket (billing lane) so the example runs with no args.
const DEFAULT_TICKET =
  "I was double charged $49.99 on invoice 4471 for account ACME-882. " +
  "My name is Dana Reyes (dana@acme.example) — please refund the duplicate charge.";

// AI-op prompt fragments.
const OP_BILLING_FIELDS =
  "extract these fields from the customer support email and return key=value pairs only: name, email, account_id, total_amount, charge_count";
const OP_BILLING_REFUND =
  "the refund amount the customer is requesting in US dollars (a single number, no currency symbol)";
const OP_BUG_STEPS =
  "extract the reproduction steps from this bug report as a flat comma-separated list (one step per item)";
const CRIT_BUG_SEVERITY =
  "severity and urgency of the reported bug, where 1.0 means production-blocking and 0.0 means cosmetic";
const PRED_BUG_REGRESSION =
  "does the report indicate this bug is a regression — that this functionality previously worked and recently broke?";
const OP_FEATURE_SUMMARY = "summarize the feature being requested in one concise sentence";
const CRIT_FEATURE_IMPACT =
  "business impact of building this feature, where 1.0 is critical to many users and 0.0 is purely cosmetic";

// The "other" lane intentionally fails the run with this message.
const ERR_OTHER_UNSUPPORTED =
  'ticket classified as "other": unsupported category — the triager only handles billing, bug, and feature tickets';

// ─── AIClientFactory: per-cost-center billing ───────────────────────────────

/**
 * Routes Claude traffic to a different API key based on the cost-center ref the
 * lane declares. The ref names a cost center; the factory looks up
 * CLAUDE_API_KEY_<COSTCENTER> and constructs a client with that key, so each
 * business unit is billed on its own account. Falls back to CLAUDE_API_KEY when
 * the per-cost-center var is unset, so the example still runs with a single key.
 * Clients are cached per ref. Gemini is unused here (this example is Claude-only)
 * and fails loud if requested.
 */
class CostCenterFactory implements ai.AIClientFactory {
  private readonly cache = new Map<string, AIClient>();

  forProvider(provider: ai.AIProvider, ref = ""): AIClient {
    if (provider !== "claude") {
      throw new Error("CostCenterFactory: Gemini is not configured for ticket-triager");
    }
    const cached = this.cache.get(ref);
    if (cached) return cached;

    const primary = ref !== "" ? `CLAUDE_API_KEY_${ref.toUpperCase()}` : "CLAUDE_API_KEY";
    let source = primary;
    let key = process.env[primary];
    if (!key && primary !== "CLAUDE_API_KEY") {
      source = "CLAUDE_API_KEY";
      key = process.env.CLAUDE_API_KEY;
    }
    if (!key) {
      throw new Error(
        `CostCenterFactory: no API key for cost center "${ref}" (looked at ${primary}, then CLAUDE_API_KEY)`,
      );
    }
    console.error(`ticket-triager.factory.resolve cost_center=${ref || "(default)"} env_var=${source}`);

    const client = new ai.AnthropicClient({ apiKey: key });
    this.cache.set(ref, client);
    return client;
  }
}

/** Builds a run context whose AI client is resolved for `costCenter`. */
function withCostCenter(ctx: RunContext, costCenter: string): RunContext {
  return { ...ctx, ai: ai.newAIClient({ provider: "claude", ref: costCenter }) };
}

// ─── Graph ───────────────────────────────────────────────────────────────────

function build() {
  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");

  // Classify into one of 4 categories via a single AI call (cost center: triage).
  const cls = wf.op({ ticket }, ({ ticket }, ctx) =>
    ai.modeSelect(ticket, { categories: CATEGORIES }, withCostCenter(ctx, "triage")),
    { name: "classify" });

  // ── Billing lane ────────────────────────────────────────────────────────
  const billingBody = wf.op({ cls, ticket }, ({ ticket }) => ticket, {
    name: "gate_billing",
    condition: ({ cls }) => cls === "billing",
  });
  const billingMap = wf.op({ billingBody }, ({ billingBody }, ctx) =>
    ai.aiExtractMap(billingBody, { operation: OP_BILLING_FIELDS }, withCostCenter(ctx, "billing")),
    { name: "billing_extract" });
  const billingRefund = wf.op({ billingBody }, ({ billingBody }, ctx) =>
    ai.aiParseNumber(billingBody, { operation: OP_BILLING_REFUND }, withCostCenter(ctx, "billing")),
    { name: "billing_refund" });
  const billingJson = wf.op({ billingMap, billingRefund }, ({ billingMap, billingRefund }) =>
    JSON.stringify({ category: "billing", details: billingMap, refund_amount_usd: billingRefund }),
    { name: "billing_encode" });

  // ── Bug lane ──────────────────────────────────────────────────────────────
  const bugBody = wf.op({ cls, ticket }, ({ ticket }) => ticket, {
    name: "gate_bug",
    condition: ({ cls }) => cls === "bug",
  });
  const bugSteps = wf.op({ bugBody }, ({ bugBody }, ctx) =>
    ai.aiExtractStringSlice(bugBody, { operation: OP_BUG_STEPS }, withCostCenter(ctx, "bug")),
    { name: "bug_steps" });
  const bugSeverity = wf.op({ bugBody }, ({ bugBody }, ctx) =>
    ai.aiScore(bugBody, { criterion: CRIT_BUG_SEVERITY }, withCostCenter(ctx, "bug")),
    { name: "bug_severity" });
  const bugRegression = wf.op({ bugBody }, ({ bugBody }, ctx) =>
    ai.aiBool(bugBody, { predicate: PRED_BUG_REGRESSION }, withCostCenter(ctx, "bug")),
    { name: "bug_regression" });
  const bugJson = wf.op(
    { bugSteps, bugSeverity, bugRegression },
    ({ bugSteps, bugSeverity, bugRegression }) =>
      JSON.stringify({
        category: "bug",
        details: {
          reproduction_steps: bugSteps,
          severity: bugSeverity,
          is_regression: bugRegression,
        },
      }),
    { name: "bug_encode" },
  );

  // ── Feature lane ────────────────────────────────────────────────────────
  const featureBody = wf.op({ cls, ticket }, ({ ticket }) => ticket, {
    name: "gate_feature",
    condition: ({ cls }) => cls === "feature",
  });
  const featureDesc = wf.op({ featureBody }, ({ featureBody }, ctx) =>
    ai.aiCompute<string>(
      featureBody,
      { operation: OP_FEATURE_SUMMARY, output: "string", name: "feature_summary" },
      withCostCenter(ctx, "feature"),
    ),
    { name: "feature_summary" });
  const featureImpact = wf.op({ featureBody }, ({ featureBody }, ctx) =>
    ai.aiScore(featureBody, { criterion: CRIT_FEATURE_IMPACT }, withCostCenter(ctx, "feature")),
    { name: "feature_impact" });
  const featureJson = wf.op({ featureDesc, featureImpact }, ({ featureDesc, featureImpact }) =>
    JSON.stringify({
      category: "feature",
      details: { description: featureDesc, business_impact: featureImpact },
    }),
    { name: "feature_encode" });

  // ── Other lane: unsupported → fail the run ────────────────────────────────
  // Gated on the "other" classification. The engine resolves every node, so when
  // a ticket classifies as "other" this op runs and throws, aborting the whole
  // run; for every supported category the condition is false and it skips.
  const otherReject = wf.op(
    { cls },
    (): string => {
      throw new Error(ERR_OTHER_UNSUPPORTED);
    },
    { name: "other_reject", condition: ({ cls }) => cls === "other" },
  );

  // ── Coalesce: the one lane that ran wins ──────────────────────────────────
  const finalBrief = wf.coalesce([billingJson, bugJson, featureJson], { name: "final" });

  return {
    wf,
    cls,
    finalBrief,
    otherReject,
    aiCandidates: [
      ["ModeSelectOp", cls],
      ["AIExtractMapOp(billing.extract)", billingMap],
      ["AIParseNumberOp(billing.refund)", billingRefund],
      ["AIExtractStringSliceOp(bug.steps)", bugSteps],
      ["AIScoreOp(bug.severity)", bugSeverity],
      ["AIBoolOp(bug.regression)", bugRegression],
      ["AIComputeStringToStringOp(feature.summary)", featureDesc],
      ["AIScoreOp(feature.impact)", featureImpact],
    ] as const,
  };
}

// ─── Driver ────────────────────────────────────────────────────────────────

interface ParsedArgs {
  ticket?: string;
  ticketText?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ticket") out.ticket = argv[++i];
    else if (argv[i] === "--ticket-text") out.ticketText = argv[++i];
  }
  return out;
}

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    // The factory falls back to CLAUDE_API_KEY; a missing key surfaces per lane.
    console.error("CLAUDE_API_KEY (or per-cost-center CLAUDE_API_KEY_<COSTCENTER>) is required");
    process.exit(1);
  }
  const { ticket, ticketText } = parseArgs(process.argv.slice(2));
  if (ticket && ticketText) {
    console.error("provide either --ticket or --ticket-text, not both");
    process.exit(2);
  }
  let ticketBody: string;
  if (ticketText !== undefined) {
    ticketBody = ticketText.trim();
  } else if (ticket !== undefined) {
    ticketBody = readFileSync(ticket, "utf8").trim();
  } else {
    // Default to a built-in billing ticket so the example runs with no args.
    ticketBody = DEFAULT_TICKET;
  }
  if (ticketBody === "") {
    console.error("ticket is empty");
    process.exit(1);
  }

  // Route every AI op through the per-cost-center factory.
  ai.setDefaultAIClientFactory(new CostCenterFactory());

  const { wf, cls, finalBrief, aiCandidates } = build();
  const result = await wf.run({
    reasoning: true,
    values: { ticket: ticketBody },
    concurrency: 10,
  });

  // The coalesced brief is a JSON string; parse it, then stamp the resolved
  // category and the AI vertices that actually fired.
  const brief = JSON.parse(result.get(finalBrief)) as Record<string, unknown>;
  brief.category = result.get(cls);
  brief.ai_nodes = aiCandidates.filter(([, node]) => !result.skipped(node)).map(([label]) => label);

  console.log(JSON.stringify(brief, null, 2));
  dumpReasoning(result.reasoning);
}

/** Prints reasoning entries to stderr; input values over 120 chars are truncated. */
function dumpReasoning(entries: ReasoningEntry[]): void {
  if (entries.length === 0) return;
  console.error("\n─── AI Reasoning ────────────────────────────────────────────────────────────");
  entries.forEach((e, i) => {
    console.error(`[${i + 1}] ${e.node}`);
    for (const [k, v] of Object.entries(e.inputs ?? {})) {
      let s = String(v).replace(/\n/g, " ");
      if (s.length > 120) s = s.slice(0, 117) + "...";
      console.error(`    ${(k + ":").padEnd(12)} ${s}`);
    }
    console.error(`    → ${e.reasoning}`);
    if (i < entries.length - 1) console.error("");
  });
  console.error("─────────────────────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
