# Stock Analyzer Example

A hybrid deterministic/AI workflow that fetches live stock data and news from Yahoo Finance, performs deterministic calculations, and generates an investment recommendation.

## Overview

1.  **Parallel Fetch**: Retrieves stock quotes and news headlines concurrently using `HTTPGetOp`.
2.  **Deterministic Math**: Calculates the price change since the previous close.
3.  **AI Sentiment**: Scores the latest news headline for bullish/bearish sentiment.
4.  **Integrated Advice**: Combines all signals into a single prompt for Gemini to provide a Buy/Hold/Sell recommendation.

## Usage

```bash
# Analyze Apple (default)
tsx main.ts --ticker AAPL

# Analyze TSLA with verbose execution details
tsx main.ts --ticker TSLA -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
