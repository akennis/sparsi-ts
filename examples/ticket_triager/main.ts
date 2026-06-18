import { Workflow } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const ticket = wf.input<string>("ticket");

  const category = wf.ai.modeSelect(ticket, {
    categories: ["Hardware", "Software", "Network", "Access"],
    name: "classify"
  });

  const priority = wf.ai.compute(ticket, {
    operation: "Determine the priority (High, Medium, Low).",
    output: "string",
    name: "priority"
  });

  const result = wf.op({ category, priority }, ({ category, priority }) => ({ category, priority }), { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  runDualMode(build, {
    name: "ticket_triager",
    inputMapping: { ticket: "ticket" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
