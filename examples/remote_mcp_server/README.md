# Remote MCP Server Search Example

Demonstrates the use of a remote HTTP-based Model Context Protocol (MCP) server to perform documentation searches.

## Overview

This example connects to the public Cloudflare Documentation MCP server to search their docs. It uses the `MCPCallOp` with the `http` transport.

## Usage

```bash
tsx main.ts --query "how do I use workers?"
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
