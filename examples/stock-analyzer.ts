/**
 * AI example (Gemini) — fetch a live quote + news headline for a stock ticker,
 * score the headline's sentiment, and produce a Buy/Hold/Sell recommendation.
 *
 * A clean one-shot CLI: the DAG fans out to two live Yahoo Finance endpoints in
 * parallel, extracts fields, AI-parses the prices, computes the change
 * deterministically, AI-scores sentiment, and runs a final AI string→string
 * recommendation.
 *
 * Requires GEMINI_API_KEY. Hits live network (Yahoo Finance).
 *   npm run example:stock -- --ticker AAPL
 */
import { Workflow, ai, ops } from "../src";

const MODEL = "gemini-3-flash-preview";

// Yahoo Finance endpoints.
const QUOTE_PREFIX = "https://query2.finance.yahoo.com/v8/finance/chart/";
const QUOTE_SUFFIX = "?interval=1d&range=1d";
const NEWS_PREFIX = "https://query2.finance.yahoo.com/v1/finance/search?q=";
const NEWS_SUFFIX = "&quotesCount=0&newsCount=1";

// JSON-extraction paths.
const PATH_PRICE = "chart.result.0.meta.regularMarketPrice";
const PATH_PREV_CLOSE = "chart.result.0.meta.chartPreviousClose";
const PATH_NEWS_TITLE = "news.0.title";

// Final-analysis prompt fragments.
const PROMPT_HEADER = "Analysis for stock ticker: ";
const PROMPT_PRICE = "\nCurrent Price: ";
const PROMPT_CHANGE = "\nPrice Change (since prev close): ";
const PROMPT_HEADLINE = "\nLatest Headline: ";
const PROMPT_SENTIMENT = "\nSentiment Score (0.0=bearish, 1.0=bullish): ";
const PROMPT_FOOTER =
  "\n\nBased on these data points, provide a concise Buy/Hold/Sell recommendation with a one-sentence rationale.";

function build() {
  const wf = new Workflow();
  const ticker = wf.input<string>("ticker");

  // Fetch quote + news in parallel.
  const quoteJson = wf.op({ ticker }, ({ ticker }, ctx) =>
    ops.io.httpGet(QUOTE_PREFIX + ticker + QUOTE_SUFFIX, ctx.signal).then((r) => r.body),
    { name: "fetch_quote" },
  );
  const newsJson = wf.op({ ticker }, ({ ticker }, ctx) =>
    ops.io.httpGet(NEWS_PREFIX + ticker + NEWS_SUFFIX, ctx.signal).then((r) => r.body),
    { name: "fetch_news" },
  );

  // Extract raw fields.
  const priceRaw = wf.op({ quoteJson }, ({ quoteJson }) =>
    ops.json.jsonExtract(quoteJson, PATH_PRICE), { name: "extract_price" });
  const prevRaw = wf.op({ quoteJson }, ({ quoteJson }) =>
    ops.json.jsonExtract(quoteJson, PATH_PREV_CLOSE), { name: "extract_prev" });
  const headline = wf.op({ newsJson }, ({ newsJson }) =>
    ops.json.jsonExtract(newsJson, PATH_NEWS_TITLE), { name: "extract_news" });

  // AI-parse the prices (string → float64 fallback).
  const price = wf.op({ priceRaw }, ({ priceRaw }, ctx) =>
    ai.aiParseNumber(priceRaw, { model: MODEL }, ctx), { name: "parse_price" });
  const prevClose = wf.op({ prevRaw }, ({ prevRaw }, ctx) =>
    ai.aiParseNumber(prevRaw, { model: MODEL }, ctx), { name: "parse_prev" });

  // Deterministic change.
  const change = wf.op({ price, prevClose }, ({ price, prevClose }) =>
    ops.num.sub(price, prevClose), { name: "calc_change" });

  // AI sentiment in [0,1].
  const sentiment = wf.op({ headline }, ({ headline }, ctx) =>
    ai.aiScore(
      headline,
      { criterion: "The headline indicates a positive/bullish outlook for the company", model: MODEL },
      ctx,
    ),
    { name: "sentiment" },
  );

  // Build the final prompt in one op, with default float formatting for change +
  // sentiment.
  const finalPrompt = wf.op(
    { ticker, priceRaw, change, headline, sentiment },
    ({ ticker, priceRaw, change, headline, sentiment }) =>
      PROMPT_HEADER + ticker +
      PROMPT_PRICE + priceRaw +
      PROMPT_CHANGE + ops.text.numberToString(change) +
      PROMPT_HEADLINE + headline +
      PROMPT_SENTIMENT + ops.text.numberToString(sentiment) +
      PROMPT_FOOTER,
    { name: "build_prompt" },
  );

  const recommendation = wf.op({ finalPrompt }, ({ finalPrompt }, ctx) =>
    ai.aiCompute<string>(
      finalPrompt,
      {
        operation: "Analyze the given stock data and sentiment to provide a Buy/Hold/Sell recommendation.",
        output: "string",
        name: "recommend",
        model: MODEL,
      },
      ctx,
    ),
    { name: "recommend" },
  );

  return { wf, recommendation };
}

function parseTicker(argv: string[]): string {
  const i = argv.indexOf("--ticker");
  const raw = (i >= 0 ? argv[i + 1] : undefined) ?? "AAPL";
  return raw.toUpperCase();
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required");
    process.exit(1);
  }
  const ticker = parseTicker(process.argv.slice(2));
  const { wf, recommendation } = build();
  const result = await wf.run({
    ai: new ai.GeminiClient({ model: MODEL }),
    values: { ticker },
    concurrency: 4,
  });

  console.log(`\nAnalysis for ${ticker}:`);
  console.log("-----------------------------------");
  console.log(result.get(recommendation));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
