import { Workflow, ops } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const meal = wf.input<string>("meal");

  const url = wf.op({ meal }, ({ meal }) => `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(meal)}`, { name: "url" });
  const response = wf.op({ url }, ({ url }) => ops.io.httpGet(url), { name: "fetch" });
  
  const instructions = wf.op({ response }, ({ response }) => {
    const data = JSON.parse(response.body);
    if (!data.meals || data.meals.length === 0) throw new Error("Meal not found");
    return data.meals[0].strInstructions;
  }, { name: "instructions" });

  const ingredients = wf.ai.extractStringSlice(instructions, { operation: "Extract ingredients as a list of strings.", name: "ingredients" });
  const steps = wf.ai.extractStringSlice(instructions, { operation: "Extract cooking steps as a list of strings.", name: "steps" });
  const cookTime = wf.ai.parseNumber(instructions, { operation: "Estimate total cooking time in minutes as a number.", name: "cook_time" });

  const difficulty = wf.op({ ingredients, steps, cookTime }, ({ ingredients, steps, cookTime }) => {
    const score = ingredients.length * 0.5 + steps.length + cookTime * 0.1;
    return score > 30 ? "hard" : score > 15 ? "medium" : "easy";
  }, { name: "difficulty" });

  const result = wf.op({ meal, difficulty, ingredients, steps, cookTime }, ({ meal, difficulty, ingredients, steps, cookTime }) => {
    return {
      meal,
      difficulty,
      metrics: {
        ingredients: ingredients.length,
        steps: steps.length,
        cook_time: cookTime
      }
    };
  }, { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  runDualMode(build, {
    name: "recipe_analyzer",
    inputMapping: { meal: "meal" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
