/**
 * AI example (Gemini) — a recipe difficulty analyzer.
 *
 * Given a meal name (live TheMealDB API) or a captured fixture, it extracts the
 * cooking instructions, runs three AI extractors in parallel (ingredients, steps,
 * estimated cook minutes), computes a deterministic difficulty score from those
 * signals, then routes the result through one of three difficulty-specific advice
 * lanes gated on the score and merged by coalesce.
 *
 * The `--meal` (live) and `--fixture` (offline) CLI modes are both kept; the live
 * HTTP fetch / fixture read is resolved here in main() rather than in-graph, so
 * the workflow itself is the pure analysis DAG.
 *
 * Requires GEMINI_API_KEY. `--meal` also hits live network (TheMealDB). With no
 * args it defaults to a live "Spaghetti Carbonara" lookup.
 *   npm run example:recipe                                  # live "Spaghetti Carbonara"
 *   npm run example:recipe -- --meal "Spaghetti Carbonara"
 *   npm run example:recipe -- --fixture examples/testdata/recipe/carbonara.json
 */
import { readFileSync } from "node:fs";
import { Workflow, ai, ops } from "../src";

const MODEL = "gemini-3-flash-preview";

// Difficulty band thresholds.
const EASY_MAX = 20.0;
const HARD_MIN = 50.0;

// Score weights.
const STEP_WEIGHT = 1.0;
const COOK_WEIGHT = 0.1;

// JSON-extraction paths into the TheMealDB search response.
const PATH_INSTRUCTIONS = "meals.0.strInstructions";
const PATH_MEALNAME = "meals.0.strMeal";

const THEMEALDB_SEARCH = "https://www.themealdb.com/api/json/v1/1/search.php?s=";

// AI-op prompt fragments.
const OP_INGREDIENTS =
  "extract every distinct ingredient name from this recipe as a flat list (one ingredient per item; no quantities or units)";
const OP_STEPS =
  "extract every discrete step required to prepare and cook the meal as a flat list (one step per item); exclude optional storage (like freezing) and serving suggestions";
const OP_COOK_MINUTES =
  "estimate total active and passive cooking time in minutes; if a step is optional or provides a time range, use the minimum time; respond with a single integer";
const OP_EASY =
  "write a one-sentence encouraging tip for a beginner cook making this recipe; reference the recipe by name";
const OP_MEDIUM =
  "write a one-sentence intermediate tip for a home cook attempting this recipe; reference the recipe by name";
const OP_HARD =
  "write a one-sentence pro-level tip for an experienced cook tackling this recipe; reference the recipe by name";

function build() {
  const wf = new Workflow();
  // The external boundary: the raw TheMealDB search JSON body (resolved in main()).
  const body = wf.input<string>("body");

  // Stage 1 — pull the instructions text (required) and meal name out of the JSON.
  const instructions = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_INSTRUCTIONS, true), {
    name: "extract_instructions",
  });
  const mealName = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_MEALNAME), {
    name: "extract_mealname",
  });

  // Stage 2 — three parallel AI extractors over the instructions text.
  const ingredients = wf.op({ instructions }, ({ instructions }, ctx) =>
    ai.aiExtractStringSlice(instructions, { operation: OP_INGREDIENTS, model: MODEL }, ctx),
    { name: "ingredients" });
  const steps = wf.op({ instructions }, ({ instructions }, ctx) =>
    ai.aiExtractStringSlice(instructions, { operation: OP_STEPS, model: MODEL }, ctx),
    { name: "steps" });
  const cookMinutes = wf.op({ instructions }, ({ instructions }, ctx) =>
    ai.aiParseNumber(instructions, { operation: OP_COOK_MINUTES, model: MODEL }, ctx),
    { name: "cook_minutes" });

  // Stage 3 — deterministic difficulty score:
  //   ingredient_count + step_count * step_weight + cook_minutes * cook_weight.
  const ingredientCount = wf.op({ ingredients }, ({ ingredients }) => ingredients.length, {
    name: "ingredient_count",
  });
  const stepCount = wf.op({ steps }, ({ steps }) => steps.length, { name: "step_count" });
  const difficultyScore = wf.op(
    { ingredientCount, stepCount, cookMinutes },
    ({ ingredientCount, stepCount, cookMinutes }) =>
      ingredientCount + stepCount * STEP_WEIGHT + cookMinutes * COOK_WEIGHT,
    { name: "difficulty_score" },
  );

  // Stage 4 — three difficulty lanes, each gated by a predicate over the score
  // and feeding a difficulty-specific AI advice op over the meal name. Exactly
  // one fires per run.
  const easyAdvice = wf.op(
    { difficultyScore, mealName },
    ({ mealName }, ctx) =>
      ai.aiCompute<string>(mealName, { operation: OP_EASY, output: "string", name: "easy_advice", model: MODEL }, ctx),
    { name: "easy_advice", condition: ({ difficultyScore }) => difficultyScore < EASY_MAX },
  );
  const mediumAdvice = wf.op(
    { difficultyScore, mealName },
    ({ mealName }, ctx) =>
      ai.aiCompute<string>(mealName, { operation: OP_MEDIUM, output: "string", name: "medium_advice", model: MODEL }, ctx),
    {
      name: "medium_advice",
      condition: ({ difficultyScore }) => difficultyScore >= EASY_MAX && difficultyScore < HARD_MIN,
    },
  );
  const hardAdvice = wf.op(
    { difficultyScore, mealName },
    ({ mealName }, ctx) =>
      ai.aiCompute<string>(mealName, { operation: OP_HARD, output: "string", name: "hard_advice", model: MODEL }, ctx),
    { name: "hard_advice", condition: ({ difficultyScore }) => difficultyScore >= HARD_MIN },
  );

  // Stage 5 — coalesce the three lanes into a single advice wire.
  const advice = wf.coalesce([easyAdvice, mediumAdvice, hardAdvice], { name: "advice" });

  return {
    wf,
    mealName,
    ingredientCount,
    stepCount,
    cookMinutes,
    difficultyScore,
    advice,
    ingredients,
    steps,
    lanes: { easy: easyAdvice, medium: mediumAdvice, hard: hardAdvice },
  };
}

interface ParsedArgs {
  meal?: string;
  fixture?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--meal") out.meal = argv[++i];
    else if (argv[i] === "--fixture") out.fixture = argv[++i];
  }
  return out;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required");
    process.exit(1);
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.meal && parsed.fixture) {
    console.error("specify exactly one of --meal or --fixture");
    process.exit(2);
  }
  // Default to a live "Spaghetti Carbonara" lookup so the example runs with no args.
  const meal = parsed.meal ?? (parsed.fixture ? undefined : "Spaghetti Carbonara");
  const fixture = parsed.fixture;

  // Resolve the TheMealDB search body: read a fixture offline, or fetch live.
  const live = !fixture;
  let body: string;
  if (fixture) {
    body = readFileSync(fixture, "utf8");
  } else {
    const url = THEMEALDB_SEARCH + encodeURIComponent(meal as string);
    const resp = await ops.io.httpGet(url);
    if (resp.statusCode !== 200) {
      console.error(`HTTP fetch returned status ${resp.statusCode}`);
      process.exit(1);
    }
    body = resp.body;
  }

  const {
    wf,
    mealName,
    ingredientCount,
    stepCount,
    cookMinutes,
    difficultyScore,
    advice,
    ingredients,
    steps,
    lanes,
  } = build();

  let result;
  try {
    result = await wf.run({
      ai: new ai.GeminiClient({ model: MODEL }),
      values: { body },
      concurrency: 10,
    });
  } catch (err) {
    // A missing required instructions path means the meal wasn't found.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(ops.json.ErrRequiredPathMissing)) {
      console.error(live ? `no results found for "${meal}" on TheMealDB` : "fixture contains no results");
      process.exit(1);
    }
    throw err;
  }

  // Which difficulty lane fired determines the difficulty label.
  let difficulty = "unknown";
  for (const [label, node] of [
    ["easy", lanes.easy],
    ["medium", lanes.medium],
    ["hard", lanes.hard],
  ] as const) {
    if (!result.skipped(node)) {
      difficulty = label;
      break;
    }
  }

  // Record which AI vertices actually fired (skipped lanes are pruned).
  const aiNodes: string[] = [];
  for (const [label, node] of [
    ["AIExtractStringSliceOp(ingredients)", ingredients],
    ["AIExtractStringSliceOp(steps)", steps],
    ["AIParseNumberOp(cook_minutes)", cookMinutes],
    ["AIComputeStringToStringOp(easy.advice)", lanes.easy],
    ["AIComputeStringToStringOp(medium.advice)", lanes.medium],
    ["AIComputeStringToStringOp(hard.advice)", lanes.hard],
  ] as const) {
    if (!result.skipped(node)) aiNodes.push(label);
  }

  const out = {
    meal: result.get(mealName),
    ingredient_count: result.get(ingredientCount),
    step_count: result.get(stepCount),
    cook_minutes: result.get(cookMinutes),
    difficulty_score: result.get(difficultyScore),
    difficulty,
    advice: result.get(advice),
    ai_nodes: aiNodes,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
