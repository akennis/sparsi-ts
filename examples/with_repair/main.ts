import { readFileSync } from "node:fs";
import { Workflow } from "../../src";
import { runDualMode } from "../common";

const TICKET_SCHEMA_SPEC = `Required JSON shape:
{
  "id":              string matching ^T-\\d+$,
  "priority":        one of "low" | "medium" | "high" | "urgent",
  "reporter_email":  RFC-shaped email address,
  "summary":         non-empty string,
  "escalation_contact": optional email (required when priority=="urgent")
}`;

const ID_PATTERN = /^T-\d+$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VALID_PRIOS = new Set(["low", "medium", "high", "urgent"]);

function parseTicket(raw: string) {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`The text below should be a valid ticket JSON, but parsing failed:\n  ${e}\n\n${TICKET_SCHEMA_SPEC}\n\nInput:\n${raw}\n\nOutput corrected JSON only — the entire object, not a patch. No code fences.`);
  }

  const v: string[] = [];
  if (!ID_PATTERN.test(data.id || "")) v.push(`field "id" must match ^T-\\d+$, got "${data.id}"`);
  if (!VALID_PRIOS.has(data.priority)) v.push(`field "priority" must be one of low|medium|high|urgent, got "${data.priority}"`);
  if (!EMAIL_PATTERN.test(data.reporter_email || "")) v.push(`field "reporter_email" must look like an email, got "${data.reporter_email}"`);
  if (!(data.summary || "").trim()) v.push(`field "summary" must be non-empty`);

  if (v.length > 0) {
    throw new Error(`The JSON below parses but violates the ticket schema:\n  - ${v.join('\n  - ')}\n\n${TICKET_SCHEMA_SPEC}\n\nInput:\n${raw}\n\nOutput corrected JSON only — the entire object, not a patch. No code fences.`);
  }
  return data;
}

function validateRouting(ticket: any) {
  if (ticket.priority === "urgent" && !(ticket.escalation_contact || "").trim()) {
    throw new Error(`The ticket below has priority="urgent" but no escalation_contact. Routing requires an escalation_contact for urgent tickets. Choose a sensible value based on the summary, or fall back to "oncall@example.com". Output the corrected ticket as JSON. No code fences.\n\nInput:\n${JSON.stringify(ticket)}`);
  }
  if ((ticket.summary || "").length > 280) {
    throw new Error(`The ticket below has a summary longer than 280 characters. Rewrite the summary to be at most 280 characters while preserving the technical detail. Output the corrected ticket as JSON. No code fences.\n\nInput:\n${JSON.stringify(ticket)}`);
  }
  return ticket;
}

function build() {
  const wf = new Workflow();
  const rawInput = wf.input<string>("raw_text");

  const parsed = wf.ai.repair(
    rawInput,
    { 
        name: "repair_parse",
        codec: { encode: (v) => v, decode: (v) => v },
        run: (raw: string) => parseTicket(raw)
    }
  );

  const validated = wf.ai.repair(
    parsed,
    { 
        name: "repair_routing",
        codec: { encode: (v) => JSON.stringify(v), decode: (v) => JSON.parse(v) },
        run: (ticket: any) => validateRouting(ticket)
    }
  );

  return { wf, validated };
}

if (require.main === module) {
  const main = async () => {
      let inputArgs = process.argv.find(a => a.startsWith("--input"));
      let inputVal = inputArgs ? inputArgs.split("=")[1] || process.argv[process.argv.indexOf("--input")+1] : "";
      
      let rawText = inputVal;
      if (inputVal && inputVal.startsWith("@")) {
          rawText = readFileSync(inputVal.slice(1), "utf8");
      }

      process.argv = process.argv.filter(a => a !== "--input" && a !== inputVal);
      process.argv.push("--raw_text", rawText || "");

      runDualMode(build, {
        name: "with_repair",
        inputMapping: { raw_text: "raw_text" },
        outputNode: build().validated
      }).catch(err => {
        console.error(err);
        process.exit(1);
      });
  };
  main();
}
