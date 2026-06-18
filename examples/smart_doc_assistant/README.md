# Smart Document Assistant Example

An intelligent RAG assistant that uses semantic search (via embeddings) and citation validation to answer questions about provided documents.

## Overview

- **Hybrid Retrieval**: Combines semantic understanding with grounded generation.
- **Citation Enforcement**: Every claim is linked back to a source document, with automated validation to prevent hallucinations.
- **Structured Output**: Provides answers in a clear, cited format.

## Usage

```bash
tsx main.ts --question "What are the key benefits of Sparsi?" --kb path/to/docs -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
