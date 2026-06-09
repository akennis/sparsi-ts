export {
  AnthropicClient,
  GeminiClient,
  MockAIClient,
  withRetry,
  isTransientError,
  requireAI,
} from "./client";
export type {
  AnthropicClientOptions,
  GeminiClientOptions,
  RetryConfig,
  MockHandler,
} from "./client";

export {
  EnvAIClientFactory,
  newAIClient,
  setDefaultAIClientFactory,
  registerAIClientFactory,
  resolveAIClientFactory,
} from "./factory";
export type { AIProvider, AIClientFactory, NewAIClientOptions } from "./factory";

export { aiCompute, parseResult, ErrRepairable } from "./compute";
export type { OutputKind, AIComputeOptions } from "./compute";

export { withRepair, WithRepairDescription } from "./repair";
export type { WithRepairConfig } from "./repair";

export {
  modeSelect,
  aiBool,
  aiScore,
  aiClassifyMultiLabel,
  aiBestMatch,
  aiRerank,
  aiSummarize,
  aiExtractStringSlice,
  aiExtractMap,
  aiParseNumber,
} from "./ops";
export type { AIOpOptions } from "./ops";

export {
  ModeSelectOpDescription,
  AIComputeStringToStringOpDescription,
  AIComputeMathOperandsToFloat64OpDescription,
  AIExtractStringSliceOpDescription,
  AIExtractMapOpDescription,
  AIParseNumberOpDescription,
  AISummarizeOpDescription,
  AIClassifyMultiLabelOpDescription,
  AIScoreOpDescription,
  AIBoolOpDescription,
  AIBestMatchOpDescription,
  AIRerankOpDescription,
} from "./descriptions";
