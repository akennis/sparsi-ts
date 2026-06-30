# HackerNews Topic Brief Example

Fetches top stories from HackerNews for a given query and generates a curated brief in one of three styles (Technical, Business, or Policy) based on the dominant category of the results.

## Overview

This example showcases advanced `dagor` features:

- **Parallel Processing**: Uses `MapOver` to run relevance checks and category classification on multiple story titles concurrently.
- **Dynamic Routing**: Uses `ModeSelectOp` and `DominantCategoryOp` to determine the best brief style.
- **Conditional Execution**: Executes only the relevant "lane" (Technical, Business, or Policy) based on the determined style.
- **Coalescing**: Merges the result of the parallel lanes into a single output using `CoalesceNStringOp`.

## Usage

```bash
# Generate a brief for "AI"
tsx main.ts --query "AI"

# Generate a brief for "Kubernetes" with verbose logs
tsx main.ts --query "Kubernetes" -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
