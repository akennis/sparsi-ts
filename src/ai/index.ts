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
export type { OutputKind, AIComputeOptions, AIComputeResult } from "./compute";

// Side-effect import: installs the `wf.ai` accessor on Workflow.prototype.
import "./graph";
export { AINamespace } from "./graph";
export type { AINodeOptions, AIComputeNodeOptions } from "./graph";

export { withRepair, WithRepairDescription, textCodec, jsonCodec, xmlCodec } from "./repair";
export type { WithRepairConfig, RepairCodec, XMLCodecSpec } from "./repair";

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
