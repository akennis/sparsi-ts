# Local MCP Server (Playwright) Example

Demonstrates browser automation using the Model Context Protocol (MCP) and Playwright. It searches Google for a query and takes screenshots of the top result URLs in parallel.

## Overview

This example shows how to integrate external tools via MCP:

- **Session Continuity**: The search step uses a single browser session (navigate → type → search).
- **Parallel Fan-out**: Once URLs are extracted, it launches multiple Playwright instances in parallel via `MapOver` to take screenshots concurrently.
- **Custom MCP Ops**: Implements `MCPGoogleSearchURLsOp` and `MCPScreenshotURLOp` as specialized operators.

## Prerequisites

- `Node.js` and `npx` must be available on your PATH.
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.

## Usage

```bash
# Search for "Shizuoka" and save screenshots to .playwright-mcp/
tsx main.ts --query "Shizuoka"

# Customize search and output directory
tsx main.ts --query "Mt Fuji" --out-dir "C:/path/to/shots" -v
```

**Note**: `--out-dir` must be an absolute path.
