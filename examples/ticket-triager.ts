/**
 * AI example — a customer-support ticket triager.
 *
 * It reads a free-text ticket (from a file via --ticket or inline via
 * --ticket-text),
 * classifies it via modeSelect into one of {billing, bug, feature, other}, and
 * routes the ticket through a category-specific extraction lane. The billing,
 * bug, and feature lanes are DAG branches gated on the classification; only the
 * matching lane fires, and its per-lane brief coalesces into a final, typed
 * brief. Tickets that classify as "other" are intentionally unsupported: the
 * "other" lane fails the run instead of producing a brief.
 *
 * AIClientFactory demo. Every AI vertex resolves its client through a custom
 * factory (CostCenterFactory below) keyed on a "cost center" ref (triage,
 * billing, bug, feature). The factory maps the ref onto an env var
 * (CLAUDE_API_KEY_<COSTCENTER>) so each team can be billed on its own API key,
 * falling back to CLAUDE_API_KEY when the per-cost-center key is unset so the
 * demo still runs with the default single-key setup. Each lane selects its
 * cost-center client through the per-op `ai` option, so no AI op has to
 * reconstruct the engine-owned run context to redirect itself.
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
import { parseArgs } from "node:util";
import { Workflow, ai } from "../src";
import type { AIClient, ReasoningEntry } from "../src";

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
    console.error(`ticket-triager: resolved cost center "${ref || "default"}" from ${source}`);

    const client = new ai.AnthropicClient({ apiKey: key });
    this.cache.set(ref, client);
    return client;
  }
}

// ─── Graph ───────────────────────────────────────────────────────────────────

// Per-lane brief shapes. Each lane is self-describing — it carries its own
// `category` literal — so `coalesce` returns the union and the driver reads the
// winning brief directly, with no JSON-stringify/parse round-trip and no
// post-hoc mutation (Finding F).
interface BillingBrief {
  category: "billing";
  details: Record<string, string>;
  refund_amount_usd: number;
}
interface BugBrief {
  category: "bug";
  details: { reproduction_steps: string[]; severity: number; is_regression: boolean };
}
interface FeatureBrief {
  category: "feature";
  details: { description: string; business_impact: number };
}

function build() {
  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");

  // Each lane runs under its own cost-center client, resolved through the
  // factory by ref and passed as the per-op `ai` option (Finding B) — no AI op
  // reconstructs the engine-owned RunContext to redirect itself. The factory
  // caches per ref, so these are the same clients each lane's ops share.
  const triageAI = ai.newAIClient({ provider: "claude", ref: "triage" });
  const billingAI = ai.newAIClient({ provider: "claude", ref: "billing" });
  const bugAI = ai.newAIClient({ provider: "claude", ref: "bug" });
  const featureAI = ai.newAIClient({ provider: "claude", ref: "feature" });

  // Classify into one of 4 categories via a single AI call (cost center: triage).
  const cls = wf.ai.modeSelect(ticket, { categories: CATEGORIES, name: "classify", ai: triageAI });

  // Each lane's AI ops gate on the classification. The class rides `gate` so the
  // predicate sees it without it being wired into the AI input (which is just the
  // ticket) — no identity passthrough op (Finding G). A skipped gate skips the
  // op, which propagates to the lane's encode node.
  const billingGate = (_in: unknown, { cls }: { cls: string }) => cls === "billing";
  const bugGate = (_in: unknown, { cls }: { cls: string }) => cls === "bug";
  const featureGate = (_in: unknown, { cls }: { cls: string }) => cls === "feature";

  // ── Billing lane ────────────────────────────────────────────────────────
  const billingMap = wf.ai.extractMap(ticket, {
    operation: OP_BILLING_FIELDS,
    name: "billing_extract",
    ai: billingAI,
    gate: { cls },
    condition: billingGate,
  });
  const billingRefund = wf.ai.parseNumber(ticket, {
    operation: OP_BILLING_REFUND,
    name: "billing_refund",
    ai: billingAI,
    gate: { cls },
    condition: billingGate,
  });
  const billingBrief = wf.op(
    { billingMap, billingRefund },
    ({ billingMap, billingRefund }): BillingBrief => ({
      category: "billing",
      details: billingMap,
      refund_amount_usd: billingRefund,
    }),
    { name: "billing_encode" },
  );

  // ── Bug lane ──────────────────────────────────────────────────────────────
  const bugSteps = wf.ai.extractStringSlice(ticket, {
    operation: OP_BUG_STEPS,
    name: "bug_steps",
    ai: bugAI,
    gate: { cls },
    condition: bugGate,
  });
  const bugSeverity = wf.ai.score(ticket, {
    criterion: CRIT_BUG_SEVERITY,
    name: "bug_severity",
    ai: bugAI,
    gate: { cls },
    condition: bugGate,
  });
  const bugRegression = wf.ai.bool(ticket, {
    predicate: PRED_BUG_REGRESSION,
    name: "bug_regression",
    ai: bugAI,
    gate: { cls },
    condition: bugGate,
  });
  const bugBrief = wf.op(
    { bugSteps, bugSeverity, bugRegression },
    ({ bugSteps, bugSeverity, bugRegression }): BugBrief => ({
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
  const featureDesc = wf.ai.compute(ticket, {
    operation: OP_FEATURE_SUMMARY,
    output: "string",
    name: "feature_summary",
    ai: featureAI,
    gate: { cls },
    condition: featureGate,
  });
  const featureImpact = wf.ai.score(ticket, {
    criterion: CRIT_FEATURE_IMPACT,
    name: "feature_impact",
    ai: featureAI,
    gate: { cls },
    condition: featureGate,
  });
  const featureBrief = wf.op(
    { featureDesc, featureImpact },
    ({ featureDesc, featureImpact }): FeatureBrief => ({
      category: "feature",
      details: { description: featureDesc, business_impact: featureImpact },
    }),
    { name: "feature_encode" },
  );

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

  // ── Coalesce: the one lane that ran wins; the union keeps each lane's shape ─
  const finalBrief = wf.coalesce([billingBrief, bugBrief, featureBrief], { name: "final" });

  return {
    wf,
    finalBrief,
    otherReject,
    // The AI vertices, by reference. The driver reports which fired by reading
    // each node's own `name` and skip status, instead of a hand-maintained
    // parallel array of label strings (Finding E).
    aiVertices: [
      cls,
      billingMap,
      billingRefund,
      bugSteps,
      bugSeverity,
      bugRegression,
      featureDesc,
      featureImpact,
    ],
  };
}

// ─── Driver ────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    // The factory falls back to CLAUDE_API_KEY; a missing key surfaces per lane.
    console.error("CLAUDE_API_KEY (or per-cost-center CLAUDE_API_KEY_<COSTCENTER>) is required");
    process.exit(1);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { ticket: { type: "string" }, "ticket-text": { type: "string" } },
  });
  const ticketArg = values.ticket;
  const ticketText = values["ticket-text"];
  if (ticketArg && ticketText) {
    console.error("provide either --ticket or --ticket-text, not both");
    process.exit(2);
  }
  let ticketBody: string;
  if (ticketText !== undefined) {
    ticketBody = ticketText.trim();
  } else if (ticketArg !== undefined) {
    ticketBody = readFileSync(ticketArg, "utf8").trim();
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

  const { wf, finalBrief, aiVertices } = build();
  const result = await wf.run({
    reasoning: true,
    values: { ticket: ticketBody },
    concurrency: 10,
  });

  // The coalesced brief is the typed union from the lane that fired — read it
  // directly (no JSON.parse, no mutation). `category` is the lane's own literal
  // (Finding F); `ai_nodes` reads the fired vertices' names (Finding E).
  const brief = result.get(finalBrief);
  const aiNodes = aiVertices.filter((n) => !result.skipped(n)).map((n) => n.name);
  console.log(JSON.stringify({ ...brief, ai_nodes: aiNodes }, null, 2));
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
