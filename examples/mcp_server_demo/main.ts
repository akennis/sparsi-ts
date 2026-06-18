import { Workflow } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const name = wf.input<string>("name");
  
  const greet = wf.op({ name }, ({ name }) => `Hello, ${name}`, { name: "greet" });
  
  return { wf, greet };
}

if (require.main === module) {
  runDualMode(build, {
    name: "hello_tool",
    inputMapping: { name: "name" },
    outputNode: build().greet
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
