# Weather-Aware Outfit Advisor Example

A complex multi-stage workflow that fetches live weather data, performs parallel field extraction, applies deterministic banding, and generates AI-driven clothing recommendations.

## Overview

- **Stage 1 (Fetch)**: Gets weather data from wttr.in.
- **Stage 2 (Parallel Extraction)**: Extracts temperature, precipitation, wind, and description in parallel using `JSONExtractOp`.
- **Stage 3 (AI Parsing)**: Converts strings to numeric values using `AIParseNumberOp`.
- **Stage 4 (Deterministic Logic)**: Assigns a temperature band (Cold, Mild, Hot) and checks for "wet" or "windy" conditions using deterministic math and predicates.
- **Stage 5 (Classification)**: Uses AI to classify the general weather conditions (e.g., rain, sun, cloud).
- **Stage 6 (Generation)**: Gemini generates a 2-sentence outfit recommendation based on the processed signals.
- **Stage 7 (Safety Probe)**: An orthogonal AI probe checks for "unusual weather" and appends a warning if detected.

## Usage

```bash
# Get live advice for a city
tsx main.ts --city "New York"

# Use a captured fixture
tsx main.ts --fixture path/to/wttr.json -v
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
