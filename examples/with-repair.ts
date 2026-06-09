/**
 * AI example — `withRepair`, an AI-driven recovery wrapper around deterministic ops.
 *
 * Faithful port of sparsi-go examples/with-repair/main.go. A raw JSON support
 * ticket flows through two repair-wrapped stages:
 *
 *  1. parse_ticket — string-target repair. JSON-decodes the raw text into a
 *     strict TicketInput. On JSON syntax errors or schema violations it throws
 *     ErrRepairable carrying a self-contained prompt; the wrapper forwards it to
 *     the LLM, parses the response back into the raw text, and re-runs.
 *
 *  2. validate_routing — struct-target repair via XML. Applies business rules
 *     (priority="urgent" requires escalation_contact; summary ≤ 280 chars) and on
 *     violation throws ErrRepairable with the offending ticket rendered as XML.
 *     The wrapper sends the prompt, parses the LLM's XML response back into a
 *     TicketInput, and re-runs the validator.
 *
 * Both wire-format paths of the wrapper (string repair and XML-struct repair) are
 * exercised in one workflow. The Go `-mcp` stdio-server wrapper is intentionally
 * omitted (§6g: the MCP-server wrapper is optional); this is a clean CLI.
 *
 * A clean ticket needs zero LLM calls (the inner op succeeds first try), so it
 * runs fully offline. Dirty inputs trigger repair and need CLAUDE_API_KEY.
 *   npm run example:repair                                  # clean fixture, offline
 *   npm run example:repair -- --input @examples/testdata/with-repair/dirty-format.json
 *   npm run example:repair -- --input @examples/testdata/with-repair/dirty-business-rule.json --reasoning
 */
import { readFileSync } from "node:fs";
import { Workflow, ai } from "../src";
import { ErrRepairable } from "../src/ai";

// ─── Domain type ────────────────────────────────────────────────────────────

interface TicketInput {
  id: string;
  priority: string;
  reporter_email: string;
  summary: string;
  escalation_contact?: string;
}

// ─── Schema (verbatim from the Go consts) ───────────────────────────────────

const ID_PATTERN = /^T-\d+$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VALID_PRIOS = new Set(["low", "medium", "high", "urgent"]);

const TICKET_SCHEMA_SPEC = `Required JSON shape:
{
  "id":              string matching ^T-\\d+$,
  "priority":        one of "low" | "medium" | "high" | "urgent",
  "reporter_email":  RFC-shaped email address,
  "summary":         non-empty string,
  "escalation_contact": optional email (required when priority=="urgent")
}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Strips ``` fences the LLM may emit despite instructions. */
function stripCodeFences(s: string): string {
  s = s.trim();
  if (!s.startsWith("```")) return s;
  const i = s.indexOf("\n");
  if (i >= 0) s = s.slice(i + 1);
  const j = s.lastIndexOf("```");
  if (j >= 0) s = s.slice(0, j);
  return s.trim();
}

/** Go %q-style quoting for violation messages. */
const q = (s: string): string => JSON.stringify(s);

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Renders a ticket as indented XML, the analog of Go's xml.MarshalIndent. */
function renderTicketXML(t: TicketInput): string {
  let xml = "<ticket>\n";
  xml += `  <id>${xmlEscape(t.id)}</id>\n`;
  xml += `  <priority>${xmlEscape(t.priority)}</priority>\n`;
  xml += `  <reporter_email>${xmlEscape(t.reporter_email)}</reporter_email>\n`;
  xml += `  <summary>${xmlEscape(t.summary)}</summary>\n`;
  if (t.escalation_contact && t.escalation_contact.trim() !== "") {
    xml += `  <escalation_contact>${xmlEscape(t.escalation_contact)}</escalation_contact>\n`;
  }
  xml += "</ticket>";
  return xml;
}

/** Parses the LLM's XML repair response back into a TicketInput. */
function parseTicketXML(response: string): TicketInput {
  const cleaned = stripCodeFences(response);
  if (!/<ticket[\s>]/.test(cleaned)) {
    throw new Error(`xml: no <ticket> element in response: ${q(cleaned)}`);
  }
  const get = (tag: string): string => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(cleaned);
    return m ? xmlUnescape((m[1] ?? "").trim()) : "";
  };
  const escalation = get("escalation_contact");
  return {
    id: get("id"),
    priority: get("priority"),
    reporter_email: get("reporter_email"),
    summary: get("summary"),
    ...(escalation ? { escalation_contact: escalation } : {}),
  };
}

/** Reads --input, dereferencing the @file shorthand. */
function readInput(arg: string): string {
  if (arg.startsWith("@")) return readFileSync(arg.slice(1), "utf8");
  return arg;
}

// ─── Stage 1: parse (string-target repair) ──────────────────────────────────

function schemaViolations(t: TicketInput): string[] {
  const v: string[] = [];
  if (!ID_PATTERN.test(t.id)) v.push(`field "id" must match ^T-\\d+$, got ${q(t.id)}`);
  if (!VALID_PRIOS.has(t.priority))
    v.push(`field "priority" must be one of low|medium|high|urgent, got ${q(t.priority)}`);
  if (!EMAIL_PATTERN.test(t.reporter_email))
    v.push(`field "reporter_email" must look like an email, got ${q(t.reporter_email)}`);
  if (t.summary.trim() === "") v.push(`field "summary" must be non-empty`);
  return v;
}

/** Coerces a parsed JSON value into the strict TicketInput shape (unknown keys
 * ignored, missing fields default to ""), the analog of Go json.Unmarshal. */
function coerce(obj: unknown): TicketInput {
  const o = (obj ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const t: TicketInput = {
    id: str("id"),
    priority: str("priority"),
    reporter_email: str("reporter_email"),
    summary: str("summary"),
  };
  const esc = str("escalation_contact");
  if (esc) t.escalation_contact = esc;
  return t;
}

function parseTicket(raw: string): TicketInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ErrRepairable(
      `The text below should be a valid ticket JSON, but parsing failed:\n  ${(err as Error).message}\n\n` +
        `${TICKET_SCHEMA_SPEC}\n\nInput:\n${raw}\n\n` +
        `Output corrected JSON only — the entire object, not a patch. No code fences.`,
      err,
    );
  }
  const ticket = coerce(parsed);
  const violations = schemaViolations(ticket);
  if (violations.length > 0) {
    throw new ErrRepairable(
      `The JSON below parses but violates the ticket schema:\n  - ${violations.join("\n  - ")}\n\n` +
        `${TICKET_SCHEMA_SPEC}\n\nInput:\n${raw}\n\n` +
        `Output corrected JSON only — the entire object, not a patch. No code fences.`,
      new Error("schema: " + violations.join("; ")),
    );
  }
  return ticket;
}

// ─── Stage 2: validate (struct-target repair via XML) ───────────────────────

function validateRouting(t: TicketInput): TicketInput {
  if (t.priority === "urgent" && (t.escalation_contact ?? "").trim() === "") {
    throw new ErrRepairable(
      `The ticket below has priority="urgent" but no escalation_contact. ` +
        `Routing requires an escalation_contact for urgent tickets. ` +
        `Choose a sensible value based on the summary, or fall back to "oncall@example.com". ` +
        `Output the corrected ticket as XML using the same root element <ticket> and the same child elements. ` +
        `No code fences, no commentary.\n\nInput:\n${renderTicketXML(t)}`,
      new Error("urgent ticket missing escalation_contact"),
    );
  }
  if (t.summary.length > 280) {
    throw new ErrRepairable(
      `The ticket below has a summary longer than 280 characters (${t.summary.length}). ` +
        `Rewrite the summary to be at most 280 characters while preserving the technical detail. ` +
        `Output the corrected ticket as XML using the same root element <ticket> and the same child elements. ` +
        `No code fences, no commentary.\n\nInput:\n${renderTicketXML(t)}`,
      new Error("summary exceeds 280 chars"),
    );
  }
  return t;
}

// ─── Graph ──────────────────────────────────────────────────────────────────

function build() {
  const wf = new Workflow();
  const raw = wf.input<string>("raw");

  // Stage 1 — parse with string-target repair (PromptPrefix + maxAttempts verbatim).
  const ticket = wf.op({ raw }, ({ raw }, ctx) =>
    ai.withRepair<string, TicketInput>(
      raw,
      {
        run: (text) => parseTicket(text),
        parse: (response) => stripCodeFences(response),
        maxAttempts: 3,
        promptPrefix: "You are a strict JSON corrector. Output the corrected JSON only.\n\n",
        name: "ParseTicketRepair",
      },
      ctx,
    ),
    { name: "parse" });

  // Stage 2 — validate with struct-target (XML) repair.
  const validated = wf.op({ ticket }, ({ ticket }, ctx) =>
    ai.withRepair<TicketInput, TicketInput>(
      ticket,
      {
        run: (t) => validateRouting(t),
        parse: (response) => parseTicketXML(response),
        maxAttempts: 2,
        promptPrefix: "You are a strict XML ticket corrector. Output corrected XML only.\n\n",
        name: "ValidateRoutingRepair",
      },
      ctx,
    ),
    { name: "validate" });

  return { wf, validated };
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

interface Args {
  input?: string;
  reasoning: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { reasoning: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--input") out.input = argv[++i];
    else if (argv[i] === "--reasoning") out.reasoning = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Default to the clean fixture so `npm run example:repair` runs offline.
  const inputArg = args.input ?? "@examples/testdata/with-repair/clean.json";
  const raw = readInput(inputArg);

  const { wf, validated } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    reasoning: args.reasoning,
    values: { raw },
  });

  const out = result.get(validated);
  console.log(JSON.stringify(out, null, 2));

  if (args.reasoning && result.reasoning.length > 0) {
    process.stderr.write(`\n--- repair trace (${result.reasoning.length} entries) ---\n`);
    for (const e of result.reasoning) {
      process.stderr.write(`[${e.node}] ${e.reasoning}\n`);
    }
  }
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
