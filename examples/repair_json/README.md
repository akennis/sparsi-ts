# Repair JSON Example

Showcases AI-driven recovery from malformed input using the `WithRepair` operator.

## Overview

1.  **Faulty Input**: Receives a malformed JSON string (e.g., missing closing braces).
2.  **Repair**: `WithRepair` detects the parse failure, generates a repair prompt for Gemini, and updates the input until parsing succeeds.
3.  **Process**: Continues with deterministic logic (counting keys) once the JSON is fixed.

## Usage

```bash
tsx main.ts --json '{"name": "sparsi", "broken": ' -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
