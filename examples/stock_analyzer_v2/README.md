# Stock Analyzer V2 Example

An advanced multi-source financial analysis pipeline that integrates data from Polygon.io, NewsAPI, and FRED (Federal Reserve) to provide a comprehensive investment verdict.

## Overview

- **Multi-Source Fetching**: Collects company details, financials, latest news, and macroeconomic context (GDP, CPI, Interest Rates) in parallel.
- **Custom Pruning**: Uses specialized operators to clean and summarize large JSON responses, optimizing token usage.
- **High-Quality Reasoning**: Feeds structured financial metrics and macro trends to Gemini for a data-backed recommendation.
- **Dual Mode**: Can be run as a CLI tool or as an MCP server.

## Prerequisites

Required API keys:
- `GEMINI_API_KEY`
- `POLYGON_API_KEY`
- `NEWSAPI_API_KEY`
- `FRED_API_KEY`

## Usage

```bash
# CLI Mode
tsx main.ts --ticker MSFT

# MCP Mode
tsx main.ts --mcp
```
