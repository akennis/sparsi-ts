/**
 * AI example — extract a list, map an AI op over each element, then summarize.
 *
 * Pulls ingredient names out of a recipe, classifies each one in parallel via a
 * per-element AI call (map), and produces a one-line grocery note (summarize).
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY).
 *   npm run example:recipe
 */
import { Workflow, ai, ops } from "../src";

const SAMPLE = `Whisk 3 eggs with 1/4 cup milk. Sauté 1 diced onion and 2 cloves
garlic in olive oil. Add 1 cup chopped spinach and 100g feta. Pour in the eggs,
season with salt and pepper, and cook until set. Serve with sourdough toast.`;

function build() {
  const wf = new Workflow();
  const recipe = wf.input<string>("recipe");

  const ingredients = wf.op({ recipe }, ({ recipe }, ctx) =>
    ai.aiExtractStringSlice(
      recipe,
      { operation: "extract all distinct ingredient names from this recipe" },
      ctx,
    ),
  );

  // One AI classification per ingredient, run concurrently.
  const categories = wf.map(
    ingredients,
    (ingredient, ctx) =>
      ai.modeSelect(
        ingredient,
        { categories: ["produce", "protein", "pantry", "other"] },
        ctx,
      ),
    { name: "categorize" },
  );

  const shoppingList = wf.op({ ingredients, categories }, ({ ingredients, categories }) =>
    ops.slice.zip(ingredients, categories).map(([ing, cat]) => `${ing} → ${cat}`),
  );

  const note = wf.op({ ingredients }, ({ ingredients }, ctx) =>
    ai.aiSummarize(
      ingredients,
      { operation: "write a one-line grocery note covering these ingredients" },
      ctx,
    ),
  );

  return { wf, ingredients, shoppingList, note };
}

async function main() {
  const { wf, ingredients, shoppingList, note } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { recipe: SAMPLE },
    concurrency: 4,
  });

  console.log("ingredients:", result.get(ingredients));
  console.log("\nshopping list:");
  for (const line of result.get(shoppingList)) console.log("  " + line);
  console.log("\nnote:", result.get(note));
}

main().catch((err) => {
  console.error("run failed:", err.message);
  process.exit(1);
});
