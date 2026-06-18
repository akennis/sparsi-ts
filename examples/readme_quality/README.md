# README Quality Assessment Example

Automatically evaluates the quality of a project's README from GitHub, providing scores for completeness and clarity, and generating a constructive critique.

## Overview

1.  **Fetch**: Fetches the README from `main` or `master` branches of a GitHub repo.
2.  **Analyze**: Runs multiple AI probes to extract the project purpose, check for tests/CI, and score documentation quality.
3.  **Evaluate**: Computes an average quality score and routes the project through "Excellent", "OK", or "Poor" evaluation lanes.
4.  **Advise**: Appends a warning if no automated tests or CI are mentioned.

## Usage

```bash
# Analyze a live GitHub project
tsx main.ts --slug "google-gemini/generative-ai-python"

# Analyze a local README file
tsx main.ts --fixture path/to/README.md
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
