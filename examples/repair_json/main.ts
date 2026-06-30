import { Workflow, ai } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const rawInput = wf.input<string>("json_str");

  const parsed = wf.ai.repair(
    rawInput,
    {
      name: "repair_json",
      model: "gemini-3.1-flash-lite",
      codec: {
          encode: (v) => v,
          decode: (v) => v
      },
      run: (raw: string) => {
          try {
              return JSON.parse(raw);
          } catch (e) {
              const { ErrRepairable } = require("../../src/ai/compute");
              throw new ErrRepairable(`Invalid JSON: ${e}. Fix it.`, e);
          }
      }
    }
  );

  const countKeys = wf.op({ data: parsed }, ({ data }) => Object.keys(data).length, { name: "count_keys" });

  const finalResult = wf.op({ repaired: parsed, count: countKeys }, ({ repaired, count }) => {
    return {
      repaired,
      count
    };
  }, { name: "final_result" });

  return { wf, finalResult };
}

if (require.main === module) {
  runDualMode(build, {
    name: "repair_json",
    inputMapping: { json: "json_str" },
    outputNode: build().finalResult
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
