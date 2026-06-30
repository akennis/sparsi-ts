# RAG with Gemini Embeddings Example

Retrieval-augmented question answering over a small local knowledge base using Gemini embeddings and cosine similarity, with source-file citations.

## Overview

This example mirrors the `rag_bm25` pipeline but uses vector-based retrieval:

1.  **Embedding**: Uses `gemini-embedding-001` to convert passages into high-dimensional vectors.
2.  **Similarity Search**: Finds top matching passages by computing cosine similarity between query and document embeddings.
3.  **Validation**: Includes the same rigorous citation verification logic as the BM25 version.

## Usage

```bash
# Ask a question (must copy testdata/kb from sparsi-go first)
tsx main.ts --question "how do I return an item?" --kb ../testdata/kb -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
