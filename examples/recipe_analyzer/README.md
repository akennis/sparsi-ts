# Recipe Difficulty Analyzer Example

Fetches a recipe from TheMealDB and calculates its difficulty based on the number of ingredients, steps, and estimated cooking time.

## Overview

1.  **Extraction**: Uses specialized AI operators to extract ingredients, steps, and cook time from raw instructions text.
2.  **Scoring**: Computes a deterministic difficulty score.
3.  **Advice**: Provides a level-appropriate cooking tip based on the score (Easy, Medium, or Hard).

## Usage

```bash
# Analyze a live recipe
tsx main.ts --meal "Pancakes"

# Use a local JSON fixture
tsx main.ts --fixture path/to/recipe.json
```

## Prerequisites

- `GEMINI_API_KEY` or `GOOGLE_API_KEY` environment variable.
