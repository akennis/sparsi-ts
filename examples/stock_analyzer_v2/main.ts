import { Workflow, ops, ai } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const ticker = wf.input<string>("ticker");

  // Polygon Pipeline
  const polyKey = wf.op({}, () => ops.io.getEnv("POLYGON_API_KEY"), { name: "poly_key" });
  
  const polyDetailsUrl = wf.op({ ticker, polyKey }, ({ ticker, polyKey }) => 
    `https://api.polygon.io/v3/reference/tickers/${ticker.toUpperCase()}?apiKey=${polyKey}`, { name: "poly_details_url" });
  const polySnapshotUrl = wf.op({ ticker, polyKey }, ({ ticker, polyKey }) => 
    `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker.toUpperCase()}?apiKey=${polyKey}`, { name: "poly_snapshot_url" });
  const polyFinancialsUrl = wf.op({ ticker, polyKey }, ({ ticker, polyKey }) => 
    `https://api.polygon.io/vX/reference/financials?ticker=${ticker.toUpperCase()}&limit=1&apiKey=${polyKey}`, { name: "poly_financials_url" });

  const polyDetailsJson = wf.op({ url: polyDetailsUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_poly_details" });
  const polySnapshotJson = wf.op({ url: polySnapshotUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_poly_snapshot" });
  const polyFinancialsJson = wf.op({ url: polyFinancialsUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_poly_financials" });

  // NewsAPI Pipeline
  const newsKey = wf.op({}, () => ops.io.getEnv("NEWSAPI_API_KEY"), { name: "news_key" });
  const newsUrl = wf.op({ ticker, newsKey }, ({ ticker, newsKey }) => 
    `https://newsapi.org/v2/everything?pageSize=5&q=${ticker}&apiKey=${newsKey}`, { name: "news_url" });
  const newsJson = wf.op({ url: newsUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_news" });

  // FRED Pipeline
  const fredKey = wf.op({}, () => ops.io.getEnv("FRED_API_KEY"), { name: "fred_key" });
  const gdpUrl = wf.op({ fredKey }, ({ fredKey }) => `https://api.stlouisfed.org/fred/series/observations?series_id=GDP&api_key=${fredKey}&file_type=json&limit=1&sort_order=desc`, { name: "gdp_url" });
  const cpiUrl = wf.op({ fredKey }, ({ fredKey }) => `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key=${fredKey}&file_type=json&limit=1&sort_order=desc`, { name: "cpi_url" });
  const ratesUrl = wf.op({ fredKey }, ({ fredKey }) => `https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key=${fredKey}&file_type=json&limit=1&sort_order=desc`, { name: "rates_url" });

  const gdpJson = wf.op({ url: gdpUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_gdp" });
  const cpiJson = wf.op({ url: cpiUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_cpi" });
  const ratesJson = wf.op({ url: ratesUrl }, ({ url }) => ops.io.httpGet(url), { name: "fetch_rates" });

  // Pruning
  const finSummary = wf.op({ details: polyDetailsJson, snapshot: polySnapshotJson, financials: polyFinancialsJson }, 
    ({ details, snapshot, financials }) => {
      const res = ["Financial Metrics Summary (via Polygon.io):"];
      try {
        const d = JSON.parse(details.body).results;
        res.push(`- Name: ${d.name}, Sector: ${d.sic_sector_description}, Industry: ${d.sic_description}`);
      } catch {}
      try {
        const t = JSON.parse(snapshot.body).ticker;
        res.push(`- Current Price: ${t.lastTrade?.p}, Volume: ${t.day?.v}, Today's Change: ${t.todaysChange} (${t.todaysChangePerc}%)`);
      } catch {}
      try {
        const f = JSON.parse(financials.body).results[0]?.financials?.income_statement;
        res.push(`- Latest Revenue: ${f.revenues?.value}, Latest Net Income: ${f.net_income_loss?.value}`);
      } catch {}
      return res.join("\n");
    }, { name: "fin_summary" });

  const newsSummary = wf.op({ news: newsJson }, ({ news }) => {
    try {
      const articles = JSON.parse(news.body).articles || [];
      const res = ["Latest News Headlines:"];
      for (const art of articles.slice(0, 5)) {
        res.push(`- ${art.title}: ${art.description}`);
      }
      return res.join("\n");
    } catch {
      return "News: N/A";
    }
  }, { name: "news_summary" });

  const macroSummary = wf.op({ gdp: gdpJson, cpi: cpiJson, rates: ratesJson }, ({ gdp, cpi, rates }) => {
    const prune = (name: string, raw: string) => {
      try {
        const obs = JSON.parse(raw).observations?.[0];
        if (obs) return `${name}: ${obs.value} (as of ${obs.date})`;
      } catch {}
      return `${name}: N/A`;
    };
    return [
      "Macroeconomic Context:",
      `- ${prune("GDP", gdp.body)}`,
      `- ${prune("Inflation (CPI)", cpi.body)}`,
      `- ${prune("Interest Rate (Fed Funds)", rates.body)}`
    ].join("\n");
  }, { name: "macro_summary" });

  // Recommendation
  const stockPrompt = wf.op({ ticker, finSummary, newsSummary, macroSummary }, 
    ({ ticker, finSummary, newsSummary, macroSummary }) => 
      `Analyze the following data for stock ticker ${ticker} and provide a Buy/Hold/Sell recommendation.\n\n` +
      `${finSummary}\n\n${newsSummary}\n\n${macroSummary}\n\n` +
      `The response must include a concise Buy/Hold/Sell verdict followed by a multi-factor rationale covering growth, valuation, debt, technicals, and macro factors.`,
    { name: "stock_prompt" });

  const recommendation = wf.ai.compute(stockPrompt, {
    operation: "Analyze the stock and provide a Buy/Hold/Sell recommendation with rationale.",
    output: "string",
    name: "recommend"
  });

  return { wf, recommendation };
}

if (require.main === module) {
  runDualMode(build, {
    name: "stock_analyzer_v2",
    inputMapping: { ticker: "ticker" },
    outputNode: build().recommendation
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
