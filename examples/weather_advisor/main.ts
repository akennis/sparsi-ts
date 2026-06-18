import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Workflow, ops } from "../../src";
import { runDualMode } from "../common";

const PRECIP_THRESH = 0.1;
const WIND_THRESH = 25.0;
const WARNING = "  ⚠ unusual weather";

const PATH_TEMP = "current_condition.0.temp_C";
const PATH_PRECIP = "current_condition.0.precipMM";
const PATH_WIND = "current_condition.0.windspeedKmph";
const PATH_DESC = "current_condition.0.weatherDesc.0.value";

const CONDITION_CATEGORIES = ["rain", "snow", "fog", "sun", "cloud", "storm"];

function build() {
  const wf = new Workflow();
  const body = wf.input<string>("body");

  const tempStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_TEMP), { name: "extract_temp" });
  const precipStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_PRECIP), { name: "extract_precip" });
  const windStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_WIND), { name: "extract_wind" });
  const descStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_DESC), { name: "extract_desc" });

  const tempC = wf.ai.parseNumber(tempStr, { operation: "extract temperature", name: "parse_temp" });
  const precipMM = wf.ai.parseNumber(precipStr, { operation: "extract precipitation", name: "parse_precip" });
  const windKph = wf.ai.parseNumber(windStr, { operation: "extract wind speed", name: "parse_wind" });

  const cold = wf.op({ tempC }, () => "cold", { name: "cold", condition: ({ tempC }) => tempC < 10.0 });
  const mild = wf.op({ tempC }, () => "mild", { name: "mild", condition: ({ tempC }) => tempC >= 10.0 && tempC < 22.0 });
  const hot = wf.op({ tempC }, () => "hot", { name: "hot", condition: ({ tempC }) => tempC >= 22.0 });
  const band = wf.coalesce([cold, mild, hot], { name: "band" });

  const wet = wf.op({ precipMM }, ({ precipMM }) => precipMM > PRECIP_THRESH, { name: "wet_check" });
  const windy = wf.op({ windKph }, ({ windKph }) => windKph > WIND_THRESH, { name: "windy_check" });

  const conditions = wf.ai.classifyMultiLabel(descStr, { categories: CONDITION_CATEGORIES, name: "classify_conditions" });

  const outfitInput = wf.op(
    { band, wet, windy, tempC, conditions },
    ({ band, wet, windy, tempC, conditions }) =>
      `Temperature: ${tempC.toFixed(1)}°C (${band}), precipitation: ${wet ? "rainy/wet" : "dry"}, wind: ${windy ? "windy" : "calm"}, conditions: ${conditions.length > 0 ? conditions.join(", ") : "unspecified"}`,
    { name: "pack_outfit" },
  );

  const outfitAdvice = wf.ai.compute(outfitInput, {
    operation: "Given the weather conditions, write 2 sentences recommending an outfit.",
    output: "string",
    name: "outfit_advice",
  });

  const unusual = wf.ai.bool(descStr, { predicate: "Is this unusual weather?", name: "unusual_check" });
  const finalAdvice = wf.op(
    { outfitAdvice, unusual },
    ({ outfitAdvice, unusual }) => outfitAdvice + (unusual ? WARNING : ""),
    { name: "final_concat" },
  );

  const result = wf.op({ tempC, precipMM, windKph, band, wet, windy, conditions, advice: finalAdvice }, 
    ({ tempC, precipMM, windKph, band, wet, windy, conditions, advice }) => ({ tempC, precipMM, windKph, band, wet, windy, conditions, advice }), 
    { name: "final_result" }
  );

  return { wf, result };
}

if (require.main === module) {
  // Hack to handle fetching before workflow to reuse build() easily with dual mode
  const main = async () => {
      const cityArgs = process.argv.find(a => a.startsWith("--city"));
      const city = cityArgs ? cityArgs.split("=")[1] || process.argv[process.argv.indexOf("--city")+1] : "New York";
      let body = "";
      try {
          const url = `https://wttr.in/${encodeURIComponent(city || "")}?format=j1`;
          const resp = await ops.io.httpGet(url);
          body = resp.body;
      } catch {}

      // Patch argv so it looks like we passed --body instead of --city
      process.argv = process.argv.filter(a => a !== "--city" && a !== city);
      process.argv.push("--body", body);

      runDualMode(build, {
        name: "weather_advisor",
        inputMapping: { body: "body" },
        outputNode: build().result
      }).catch(err => {
        console.error(err);
        process.exit(1);
      });
  };
  main();
}
