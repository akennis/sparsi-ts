# Faithful Summary Example

Summarizes a document using Gemini and then performs an AI-driven faithfulness check to ensure no information was invented or added.

## Overview

This example demonstrates a classic LLM pipeline pattern: **Generation followed by Verification**.

1.  **Summarize**: Uses `AIComputeStringToStringOp` to generate a concise summary.
2.  **Verify**: Uses `AIBoolOp` to check if every factual claim in the summary is grounded in the source text.

## Usage

```bash
# Summarize a text file
tsx main.ts --file path/to/document.txt

# Summarize inline text
tsx main.ts --text "The quick brown fox jumps over the lazy dog."

# Enable verbose output to see the verification step
tsx main.ts --text "..." -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
