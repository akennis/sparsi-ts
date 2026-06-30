import { Workflow, ops } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const ticker = wf.input<string>("ticker");

  const quoteUrl = wf.op({ ticker }, ({ ticker }) => `https://query2.finance.yahoo.com/v8/finance/chart/${ticker.toUpperCase()}?interval=1d&range=1d`, { name: "quote_url" });
  const newsUrl = wf.op({ ticker }, ({ ticker }) => `https://query2.finance.yahoo.com/v1/finance/search?q=${ticker.toUpperCase()}&newsCount=1`, { name: "news_url" });

  const quoteResponse = wf.op({ url: quoteUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_quote" });
  const newsResponse = wf.op({ url: newsUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_news" });

  const priceData = wf.op({ quoteResponse }, ({ quoteResponse }) => {
    try {
      const data = JSON.parse(quoteResponse.body);
      const meta = data.chart.result[0].meta;
      return { price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose };
    } catch {
      return { price: 0, prevClose: 0 };
    }
  }, { name: "parse_quote" });

  const newsHeadline = wf.op({ newsResponse }, ({ newsResponse }) => {
    try {
      const data = JSON.parse(newsResponse.body);
      return data.news[0].title;
    } catch {
      return "No news found";
    }
  }, { name: "parse_news" });

  const sentiment = wf.ai.score(newsHeadline, { criterion: "How bullish is this news headline on a scale of 0 (bearish) to 1 (bullish)?", name: "sentiment" });

  const prompt = wf.op({ ticker, priceData, newsHeadline, sentiment }, ({ ticker, priceData, newsHeadline, sentiment }) => {
    const change = priceData.price - priceData.prevClose;
    const changePct = (change / priceData.prevClose) * 100;
    return `Stock: ${ticker}\nPrice: ${priceData.price}\nChange: ${change.toFixed(2)} (${changePct.toFixed(2)}%)\nHeadline: ${newsHeadline}\nSentiment: ${sentiment}\n\nProvide a Buy/Hold/Sell recommendation.`;
  }, { name: "prompt" });

  const recommendation = wf.ai.compute(prompt, { operation: "Provide a Buy/Hold/Sell recommendation.", output: "string", name: "recommend" });

  const result = wf.op({ ticker, recommendation }, ({ ticker, recommendation }) => ({ ticker, recommendation }), { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  runDualMode(build, {
    name: "stock_analyzer",
    inputMapping: { ticker: "ticker" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
