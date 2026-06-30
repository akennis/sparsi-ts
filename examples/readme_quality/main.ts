import { Workflow, ops } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const slug = wf.input<string>("slug");

  const mainUrl = wf.op({ slug }, ({ slug }) => `https://raw.githubusercontent.com/${slug}/main/README.md`, { name: "main_url" });
  const masterUrl = wf.op({ slug }, ({ slug }) => `https://raw.githubusercontent.com/${slug}/master/README.md`, { name: "master_url" });

  const fetchMain = wf.op({ url: mainUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_main", onError: "continue" });
  const fetchMaster = wf.op({ url: masterUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_master", onError: "continue" });

  const readme = wf.op({ main: fetchMain, master: fetchMaster }, ({ main, master }) => {
    if (main && main.statusCode === 200) return main.body;
    if (master && master.statusCode === 200) return master.body;
    throw new Error("README not found on main or master branches");
  }, { name: "select_readme" });

  const purpose = wf.ai.compute(readme, { operation: "Extract the core purpose of this project in one sentence.", output: "string", name: "purpose" });
  const docScore = wf.ai.score(readme, { criterion: "How clear and complete is this documentation?", name: "doc_score" });
  const hasTests = wf.ai.bool(readme, { predicate: "Does this project mention automated tests or CI?", name: "has_tests" });

  const result = wf.op({ purpose, docScore, hasTests }, ({ purpose, docScore, hasTests }) => {
    return {
      purpose,
      score: docScore,
      has_tests: hasTests,
      verdict: docScore > 0.8 ? "excellent" : docScore > 0.5 ? "ok" : "poor"
    };
  }, { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  runDualMode(build, {
    name: "readme_quality",
    inputMapping: { slug: "slug" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
