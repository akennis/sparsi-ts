# Customer Support Ticket Triager Example

Classifies support tickets into categories and extracts their priority level to automate the initial triage process.

## Overview

1.  **Categorize**: Uses Gemini to determine the ticket category (Hardware, Software, Network, or Access).
2.  **Prioritize**: Extracts the urgency (High, Medium, or Low) using a single-word constraint.
3.  **Summarize**: Concatenates the results for a quick structured brief.

## Usage

```bash
tsx main.ts --ticket "My screen is flickering and I can't finish my report! It's urgent."
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
