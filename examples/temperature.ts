/**
 * Deterministic example — runs fully offline, no AI client needed.
 *
 * Demonstrates: typed inputs, reduce, conditional branches gated by predicates,
 * coalesce to merge the one branch that fired, and map/filter.
 *
 *   npm run example:temperature
 */
import { Workflow, ops } from "../src";

function build() {
  const wf = new Workflow();

  const temps = wf.input<number[]>("temps");

  // Mean of the week's readings.
  const mean = wf.op({ temps }, ({ temps }) => ops.num.round(ops.num.mean(temps), 1), {
    name: "mean",
  });

  // Three mutually exclusive advice lanes, each gated by a condition on the mean.
  const cold = wf.op(
    { mean },
    ({ mean }) => `Average ${mean}°C — bundle up, it's cold.`,
    { name: "cold", condition: ({ mean }) => mean < 10 },
  );
  const mild = wf.op(
    { mean },
    ({ mean }) => `Average ${mean}°C — mild, a light jacket will do.`,
    { name: "mild", condition: ({ mean }) => mean >= 10 && mean < 25 },
  );
  const hot = wf.op(
    { mean },
    ({ mean }) => `Average ${mean}°C — hot, stay hydrated.`,
    { name: "hot", condition: ({ mean }) => mean >= 25 },
  );

  // Exactly one lane runs; coalesce picks it.
  const advice = wf.coalesce([cold, mild, hot], { name: "advice" });

  // Days warmer than the mean, labelled.
  const warmDays = wf.op({ temps, mean }, ({ temps, mean }) =>
    temps
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t > mean)
      .map(({ t, i }) => `Day ${i + 1}: ${t}°C`),
  );

  return { wf, mean, advice, warmDays };
}

async function main() {
  const { wf, mean, advice, warmDays } = build();
  const result = await wf.run({ values: { temps: [4, 7, 9, 12, 6, 3, 8] } });

  console.log("mean:    ", result.get(mean));
  console.log("advice:  ", result.get(advice));
  console.log("warmDays:", result.get(warmDays));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
