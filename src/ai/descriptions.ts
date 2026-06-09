/**
 * Verbatim catalog descriptions for the AI group, ported 1:1 from sparsi-go's
 * mode_select_op.go, string_ops.go, math_ops.go, and ai_ops.go. These strings
 * are documentation surfaced by AllDescriptions / LibraryScanOp; the PORT_PROMPT
 * requires exact wording, so they are reproduced as-is (including Go-side
 * `config.Params` references — the catalog faithfully describes the library's
 * capabilities). The TS ops expose the same capability through typed options
 * (see ops.ts / compute.ts). WithRepairDescription lives in repair.ts.
 */

export const ModeSelectOpDescription = `ModeSelectOp: AI-powered classifier — maps arbitrary input text to exactly one of a fixed set of categories.
  Params:   categories string — comma-separated list of valid output values (e.g. "arithmetic expression,city name").
            max_retries string — parse/validation retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string — the text to classify.
  Outputs:  Result string — exactly one of the specified categories.`;

export const AIComputeStringToStringOpDescription = `AIComputeStringToStringOp: AI-powered string→string computation.
  Params:   operation string — plain-English description (e.g. "suggest a condiment that pairs with the given food").
            max_retries string — parse retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string — the query string.
  Outputs:  Result string, Reasoning string.`;

export const AIComputeMathOperandsToFloat64OpDescription = `AIComputeMathOperandsToFloat64Op: AI-powered fallback for operations not available in the library.
  Params:   operation string — plain-English description of what to compute (e.g. "multiply A by B").
            max_retries string — number of parse retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *MathOperands (connect PackMathOperandsOp's Result wire).
  Outputs:  Result float64, Reasoning string.`;

export const AIExtractStringSliceOpDescription = `AIExtractStringSliceOp: AI-powered extraction of a list from text.
  Params:   operation string — plain-English description (e.g. "extract all ingredient names from this recipe").
            max_retries string — parse retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string.
  Outputs:  Result []string (CSV), Reasoning string.`;

export const AIExtractMapOpDescription = `AIExtractMapOp: AI-powered extraction of key-value pairs from text.
  Params:   operation string — plain-English description (e.g. "extract name, email, and city from this contact info").
            max_retries string — parse retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string.
  Outputs:  Result map[string]string (key=value CSV), Reasoning string.`;

export const AIParseNumberOpDescription = `AIParseNumberOp: AI-powered number extraction — converts text to float64.
  Params:   operation string — plain-English description (default: leave empty to extract the number from the text).
            max_retries string — parse retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string (e.g. "two thousand", "$1.2k", "the price is 42").
  Outputs:  Result float64, Reasoning string.`;

export const AISummarizeOpDescription = `AISummarizeOp: AI-powered summarization of a list of strings into one result string.
  Params:   operation string — plain-English instruction (e.g. "summarize into one concise sentence").
            max_retries string — parse retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *[]string — items to summarize.
  Outputs:  Result string, Reasoning string.`;

export const AIClassifyMultiLabelOpDescription = `AIClassifyMultiLabelOp: AI-powered multi-label classifier — maps input to zero or more categories.
  Params:   categories string — comma-separated list of valid labels (e.g. "billing,bug,feature,spam").
            max_retries string — parse/validation retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string.
  Outputs:  Result []string — subset of categories (CSV), Reasoning string.`;

export const AIScoreOpDescription = `AIScoreOp: AI-powered scoring — returns a float64 in [0,1] measuring a criterion.
  Params:   criterion string — what to measure (e.g. "relevance to the query", "toxicity").
            max_retries string — parse/validation retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string.
  Outputs:  Result float64 ∈ [0,1], Reasoning string.`;

export const AIBoolOpDescription = `AIBoolOp: AI-powered yes/no predicate.
  Params:   predicate string — the question to answer about the input (e.g. "does this text contain PII?").
            max_retries string — parse/validation retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Input *string.
  Outputs:  Result bool, Reasoning string.`;

export const AIBestMatchOpDescription = `AIBestMatchOp: AI-powered semantic selection — returns the index of the best-matching candidate.
  Params:   max_retries string — parse/validation retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Query *string, Candidates *[]string.
  Outputs:  Result int (0-based index), Reasoning string.`;

export const AIRerankOpDescription = `AIRerankOp: AI-powered reranking — returns a permutation of candidate indices, best first.
  Params:   max_retries string — parse/validation retries (default "3").
            api_retries string — transient-error retries with exponential backoff (default "3").
            api_retry_delay_ms string — initial backoff delay in milliseconds (default "500").
            api_factory_timeout_ms string — deadline for AIClientFactory credential lookup in milliseconds (default "30000"; "0" disables).
            provider string — AI provider: "claude" (default) or "gemini".
            model string — model name passed through to the provider (default: "claude-sonnet-4-6").
            credential_ref string — opaque credential identifier passed to AIClientFactory (default ""; ignored by the bundled env-var factory).
            client_factory_id string — selects a registered AIClientFactory by id (default "" → process default).
  Inputs:   Query *string, Candidates *[]string.
  Outputs:  Result []int (permutation as CSV), Reasoning string.`;
