# AI-Driven Data Repair Example

Demonstrates the use of the `WithRepair` operator to automatically recover from malformed JSON and business rule violations in support ticket payloads.

## Overview

1.  **Parse Repair**: Detects malformed JSON (missing braces, incorrect types) and uses Gemini to fix the format.
2.  **Logic Repair**: Detects violations of business rules (e.g., urgent tickets missing an escalation contact) and uses Gemini to choose a sensible value based on the summary.
3.  **Automatic Unmarshaling**: Showcases `WithRepair`'s ability to automatically parse LLM responses as JSON or XML.

## Usage

```bash
# Repair a malformed JSON file
tsx main.ts --input "@../testdata/dirty-format.json" -v

# Repair a business rule violation
tsx main.ts --input "@../testdata/dirty-business-rule.json" -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
