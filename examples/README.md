# Sparsi-ts Examples

This directory contains a collection of examples demonstrating how to use Sparsi-ts to build deterministic-first AI workflows.

## Organized Examples

Each example is located in its own subdirectory with a `main.ts` entrypoint and a dedicated `README.md`.

- [Customer Support Ticket Triager](./ticket_triager/) - Multi-lane classification and extraction.
- [Recipe Difficulty Analyzer](./recipe_analyzer/) - Deterministic scoring over AI-extracted data.
- [README Quality Assessment](./readme_quality/) - Parallel HTTP fetching and multi-probe evaluation.
- [Weather-Aware Outfit Advisor](./weather_advisor/) - Complex multi-stage workflow with parallel extraction and banding.
- [HackerNews Topic Brief](./hn_topic_brief/) - `MapOver` fan-out and conditional aggregation.
- [Faithful Summary](./faithful_summary/) - Cross-model verification (Generation + Verification).
- [Local MCP Server (Playwright)](./local_mcp_server/) - Browser automation via MCP and Playwright.
- [Remote MCP Server Search](./remote_mcp_server/) - Connecting to remote HTTP-based MCP servers.
- [AI-Driven Data Repair](./with_repair/) - Using `WithRepair` for automatic recovery.
- [Basic RAG](./rag_basic/) - Core Retrieval-Augmented Generation pattern.
- [RAG with BM25](./rag_bm25/) - Lexical retrieval with local knowledge base and citations.
- [RAG with Gemini Embeddings](./rag_gemini_embed/) - Vector-based retrieval using Gemini.
- [Stock Analyzer](./stock_analyzer/) - Hybrid deterministic/AI financial analysis.
- [Stock Analyzer V2](./stock_analyzer_v2/) - Advanced multi-source financial pipeline.
- [MCP Server Demo](./mcp_server_demo/) - Exposing a workflow as an MCP server.
- [Repair JSON](./repair_json/) - Minimal `WithRepair` example for malformed JSON.
- [Smart Document Assistant](./smart_doc_assistant/) - Intelligent RAG with semantic search and validation.

## Running Examples

All examples support the `-v` (verbose) flag to show detailed execution logs:

```bash
npx tsx examples/weather_advisor/main.ts --city "London" -v
```

## Prerequisites

Most examples require a `GEMINI_API_KEY` (or `GOOGLE_API_KEY` / `ANTHROPIC_API_KEY`) environment variable. Some may require additional keys (e.g., `POLYGON_API_KEY`, `NEWSAPI_API_KEY`) or external tools (e.g., `Node.js` for Playwright MCP).
