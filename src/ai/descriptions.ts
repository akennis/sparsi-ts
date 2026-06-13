/**
 * Catalog descriptions for the AI op group. These strings are documentation
 * surfaced by `allDescriptions`, describing each op's typed options, inputs, and
 * outputs. The `Params` blocks list only options the ops actually accept (see
 * ops.ts / compute.ts): the op-specific option plus `maxRetries` and `model`.
 * Provider selection and credentials are configured once at client construction
 * via `newAIClient`, not per op, so they are not advertised here.
 * `WithRepairDescription` lives in repair.ts.
 *
 * The `Output:` line of each op is the bare value the op (and its `wf.ai.*` node)
 * returns. In reasoning mode the model's reasoning is delivered out-of-band via
 * `RunResult.reasoning`, not folded into the returned value.
 */

export const ModeSelectOpDescription = `ModeSelectOp: AI-powered classifier — maps arbitrary input text to exactly one of a fixed set of categories.
  Options:  categories string[] — valid output values (e.g. ["arithmetic expression", "city name"]).
            maxRetries number — parse/validation retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string — the text to classify.
  Output:   string — exactly one of the specified categories.`;

export const AIComputeStringToStringOpDescription = `AIComputeStringToStringOp: AI-powered string→string computation.
  Options:  operation string — plain-English description (e.g. "suggest a condiment that pairs with the given food").
            maxRetries number — parse retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string — the query string.
  Output:   string.`;

export const AIComputeMathOperandsToNumberOpDescription = `AIComputeMathOperandsToNumberOp: AI-powered fallback for operations not available in the library.
  Options:  operation string — plain-English description of what to compute (e.g. "multiply A by B").
            maxRetries number — number of parse retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input MathOperands (connect packMathOperands' result).
  Output:   number.`;

export const AIExtractStringSliceOpDescription = `AIExtractStringSliceOp: AI-powered extraction of a list from text.
  Options:  operation string — plain-English description (e.g. "extract all ingredient names from this recipe").
            maxRetries number — parse retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string.
  Output:   string[].`;

export const AIExtractMapOpDescription = `AIExtractMapOp: AI-powered extraction of key-value pairs from text.
  Options:  operation string — plain-English description (e.g. "extract name, email, and city from this contact info").
            maxRetries number — parse retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string.
  Output:   Record<string, string>.`;

export const AIParseNumberOpDescription = `AIParseNumberOp: AI-powered number extraction — converts text to a number.
  Options:  operation string — plain-English description (default: leave empty to extract the number from the text).
            maxRetries number — parse retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string (e.g. "two thousand", "$1.2k", "the price is 42").
  Output:   number.`;

export const AISummarizeOpDescription = `AISummarizeOp: AI-powered summarization of a list of strings into one result string.
  Options:  operation string — plain-English instruction (e.g. "summarize into one concise sentence").
            maxRetries number — parse retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string[] — items to summarize.
  Output:   string.`;

export const AIClassifyMultiLabelOpDescription = `AIClassifyMultiLabelOp: AI-powered multi-label classifier — maps input to zero or more categories.
  Options:  categories string[] — valid labels (e.g. ["billing", "bug", "feature", "spam"]).
            maxRetries number — parse/validation retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string.
  Output:   string[] — subset of categories.`;

export const AIScoreOpDescription = `AIScoreOp: AI-powered scoring — returns a number in [0,1] measuring a criterion.
  Options:  criterion string — what to measure (e.g. "relevance to the query", "toxicity").
            maxRetries number — parse/validation retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string.
  Output:   number ∈ [0,1].`;

export const AIBoolOpDescription = `AIBoolOp: AI-powered yes/no predicate.
  Options:  predicate string — the question to answer about the input (e.g. "does this text contain PII?").
            maxRetries number — parse/validation retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    input string.
  Output:   boolean.`;

export const AIBestMatchOpDescription = `AIBestMatchOp: AI-powered semantic selection — returns the index of the best-matching candidate.
  Options:  maxRetries number — parse/validation retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    query string, candidates string[].
  Output:   number — 0-based index.`;

export const AIRerankOpDescription = `AIRerankOp: AI-powered reranking — returns a permutation of candidate indices, best first.
  Options:  maxRetries number — parse/validation retries (default 3).
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
  Input:    query string, candidates string[].
  Output:   number[] — permutation of indices.`;
