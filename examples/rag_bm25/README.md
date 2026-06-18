# RAG with BM25 Example

Retrieval-augmented question answering over a small local knowledge base using the classic BM25 ranking function, with source-file citations.

## Overview

This example implements a full RAG pipeline:

1.  **Indexing**: Loads `.txt` files from `testdata/kb` and indexes them using an in-memory BM25 retriever.
2.  **Retrieval**: Finds the top matching passages for a user's question.
3.  **Prompting**: Formats the retrieved passages into a structured prompt with `<passage>` tags and source filenames.
4.  **Generation**: Gemini generates an answer grounded in the context, ending with a list of cited sources.
5.  **Validation**: `ParseCitationsOp` and `ValidateCitationsOp` ensure cited files are present in the retrieved set.

## Usage

```bash
# Ask a question (must copy testdata/kb from sparsi-go first)
tsx main.ts --question "How do I return an item?" --kb ../testdata/kb
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
