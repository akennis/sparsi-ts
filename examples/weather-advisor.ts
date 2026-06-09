/**
 * AI example — a weather-aware outfit advisor.
 *
 * Faithful port of sparsi-go examples/weather-advisor/main.go. Given a city
 * (live wttr.in API) or a captured fixture, it extracts temperature,
 * precipitation, and wind; AI-parses each into a number; derives a temperature
 * band and boolean wet/windy flags deterministically; multi-label-classifies the
 * conditions; packs every signal into one description; then asks an AI for a
 * two-sentence outfit recommendation. An orthogonal AIBool probe checks for
 * unusual weather and appends a warning suffix.
 *
 * The Go program's `-mcp` stdio-server wrapper is intentionally omitted (§6g: the
 * MCP-server wrapper is optional). The `--city` (live) and `--fixture` (offline)
 * CLI modes are both kept; the live HTTP fetch / fixture read is resolved here in
 * main() rather than in-graph, so the workflow itself is the pure analysis DAG.
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY). `--city` also hits live network.
 *   npm run example:weather -- --city London
 *   npm run example:weather -- --fixture examples/testdata/weather/london.json
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Workflow, ai, ops } from "../src";

// Deterministic thresholds (verbatim from the Go context-value consts).
const PRECIP_THRESH = 0.1; // mm — above this it's "rainy/wet"
const WIND_THRESH = 25.0; // kph — above this it's "windy"
const WARNING = "  ⚠ unusual weather";

// JSON-extraction paths into the wttr.in j1 document.
const PATH_TEMP = "current_condition.0.temp_C";
const PATH_PRECIP = "current_condition.0.precipMM";
const PATH_WIND = "current_condition.0.windspeedKmph";
const PATH_DESC = "current_condition.0.weatherDesc.0.value";

// Multi-label weather condition categories (verbatim).
const CONDITION_CATEGORIES = ["rain", "snow", "fog", "sun", "cloud", "storm"];

// AI-op prompt fragments (verbatim from the Go Params blocks).
const OP_PARSE_TEMP = "extract the temperature value as a plain number with no units";
const OP_PARSE_PRECIP = "extract the precipitation amount as a plain number with no units";
const OP_PARSE_WIND = "extract the wind speed as a plain number with no units";
const OP_OUTFIT =
  "Given the weather conditions described, write exactly 2 sentences recommending an appropriate outfit. Be specific about clothing items.";
const PRED_UNUSUAL =
  "Is the described weather unusual or extreme for typical human experience?";

function build() {
  const wf = new Workflow();
  // The external boundary: the raw wttr.in j1 JSON body (resolved in main()).
  const body = wf.input<string>("body");

  // Stage 1 — extract the four numeric/text fields (run in parallel).
  const tempStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_TEMP), {
    name: "extract_temp",
  });
  const precipStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_PRECIP), {
    name: "extract_precip",
  });
  const windStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_WIND), {
    name: "extract_wind",
  });
  const descStr = wf.op({ body }, ({ body }) => ops.json.jsonExtract(body, PATH_DESC), {
    name: "extract_desc",
  });

  // Stage 2 — AI parse numbers (three run concurrently).
  const tempC = wf.op({ tempStr }, ({ tempStr }, ctx) =>
    ai.aiParseNumber(tempStr, { operation: OP_PARSE_TEMP }, ctx), { name: "parse_temp" });
  const precipMM = wf.op({ precipStr }, ({ precipStr }, ctx) =>
    ai.aiParseNumber(precipStr, { operation: OP_PARSE_PRECIP }, ctx), { name: "parse_precip" });
  const windKph = wf.op({ windStr }, ({ windStr }, ctx) =>
    ai.aiParseNumber(windStr, { operation: OP_PARSE_WIND }, ctx), { name: "parse_wind" });

  // Stage 3 — deterministic temperature band: three mutually exclusive lanes
  // gated on temp_c, merged by coalesce (exactly one fires per run).
  const cold = wf.op({ tempC }, () => "cold", {
    name: "cold",
    condition: ({ tempC }) => tempC < 10.0,
  });
  const mild = wf.op({ tempC }, () => "mild", {
    name: "mild",
    condition: ({ tempC }) => tempC >= 10.0 && tempC < 22.0,
  });
  const hot = wf.op({ tempC }, () => "hot", {
    name: "hot",
    condition: ({ tempC }) => tempC >= 22.0,
  });
  const band = wf.coalesce([cold, mild, hot], { name: "band" });

  // Stage 4 — deterministic wet / windy boolean flags.
  const wet = wf.op({ precipMM }, ({ precipMM }) => precipMM > PRECIP_THRESH, {
    name: "wet_check",
  });
  const windy = wf.op({ windKph }, ({ windKph }) => windKph > WIND_THRESH, {
    name: "windy_check",
  });

  // Stage 5 — multi-label weather condition classifier (AI).
  const conditions = wf.op({ descStr }, ({ descStr }, ctx) =>
    ai.aiClassifyMultiLabel(descStr, { categories: CONDITION_CATEGORIES }, ctx),
    { name: "classify_conditions" });

  // Stage 6 — pack all signals into one description string (Go PackOutfitInputsOp:
  // same %.1f temperature format, "rainy/wet"/"dry", "windy"/"calm", ", "-joined
  // conditions or "unspecified").
  const outfitInput = wf.op(
    { band, wet, windy, tempC, conditions },
    ({ band, wet, windy, tempC, conditions }) =>
      `Temperature: ${tempC.toFixed(1)}°C (${band}), ` +
      `precipitation: ${wet ? "rainy/wet" : "dry"}, ` +
      `wind: ${windy ? "windy" : "calm"}, ` +
      `conditions: ${conditions.length > 0 ? conditions.join(", ") : "unspecified"}`,
    { name: "pack_outfit" },
  );

  // Stage 7 — AI outfit advice.
  const outfitAdvice = wf.op({ outfitInput }, ({ outfitInput }, ctx) =>
    ai.aiCompute<string>(
      outfitInput,
      { operation: OP_OUTFIT, output: "string", name: "outfit_advice" },
      ctx,
    ),
    { name: "outfit_advice_op" });

  // Stage 8 — orthogonal unusual-weather probe + optional warning suffix.
  const unusual = wf.op({ descStr }, ({ descStr }, ctx) =>
    ai.aiBool(descStr, { predicate: PRED_UNUSUAL }, ctx), { name: "unusual_check" });
  const finalAdvice = wf.op(
    { outfitAdvice, unusual },
    ({ outfitAdvice, unusual }) => outfitAdvice + (unusual ? WARNING : ""),
    { name: "final_concat" },
  );

  return { wf, tempC, precipMM, windKph, band, wet, windy, conditions, finalAdvice };
}

interface ParsedArgs {
  city?: string;
  fixture?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--city") out.city = argv[++i];
    else if (argv[i] === "--fixture") out.fixture = argv[++i];
  }
  return out;
}

async function main() {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  const { city, fixture } = parseArgs(process.argv.slice(2));
  if (!city && !fixture) {
    console.error("usage: weather-advisor --city <name>  |  --fixture <path>");
    process.exit(2);
  }
  if (city && fixture) {
    console.error("specify exactly one of --city or --fixture");
    process.exit(2);
  }

  // Resolve the wttr.in j1 body: read a fixture offline, or fetch live.
  let body: string;
  let cityLabel: string;
  if (fixture) {
    body = readFileSync(fixture, "utf8");
    cityLabel = basename(fixture).replace(/\.json$/, "");
  } else {
    cityLabel = city as string;
    const url = `https://wttr.in/${encodeURIComponent(cityLabel)}?format=j1`;
    const resp = await ops.io.httpGet(url);
    if (resp.statusCode !== 200) {
      console.error(`HTTP fetch returned status ${resp.statusCode}`);
      process.exit(1);
    }
    body = resp.body;
  }

  const { wf, tempC, precipMM, windKph, band, wet, windy, conditions, finalAdvice } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { body },
    concurrency: 10,
  });

  const out = {
    city: cityLabel,
    temp_c: result.get(tempC),
    precip_mm: result.get(precipMM),
    wind_kph: result.get(windKph),
    band: result.get(band),
    wet: result.get(wet),
    windy: result.get(windy),
    conditions: result.get(conditions),
    advice: result.get(finalAdvice),
    ai_nodes: [
      "AIParseNumberOp(temp)",
      "AIParseNumberOp(precip)",
      "AIParseNumberOp(wind)",
      "AIClassifyMultiLabelOp(conditions)",
      "AIComputeStringToStringOp(outfit)",
      "AIBoolOp(unusual)",
    ],
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
