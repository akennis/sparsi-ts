/**
 * RAG / retrieval surface: the Retriever contract, registry, and retrieval ops.
 * See the individual modules for behavior and SECURITY notes.
 */

export { DeadlineExceededError, isDeadlineExceeded, withDeadline } from "./timeout";

export {
  GeminiEmbeddingClient,
  EnvEmbeddingClientFactory,
  GEMINI_EMBEDDING_MAX_BATCH,
  zeroEmbeddingCredentials,
  setDefaultEmbeddingClientFactory,
  registerEmbeddingClientFactory,
  resolveEmbeddingFactory,
  resolveEmbeddingClient,
} from "./embedding";
export type {
  EmbeddingClient,
  EmbeddingClientFactory,
  EmbeddingCredentials,
  GeminiEmbeddingClientOptions,
  EmbedOnce,
  EmbedOnceResponse,
} from "./embedding";

export {
  RetrievalFilters,
  MetadataSource,
  MetadataSourceURL,
  MetadataHighlights,
  MetadataUpdatedAt,
  setDefaultRetriever,
  registerRetriever,
  resolveRetriever,
} from "./retriever";
export type { Document, Retriever, RetrievalContext } from "./retriever";

export {
  retrieve,
  retrieveWithFilters,
  parseStaticFilters,
  validateCitations,
} from "./retrieve";
export type {
  RetrieveOptions,
  RetrieveWithFiltersOptions,
  RetrieveResult,
  CitationResult,
} from "./retrieve";

export {
  RetrieveOpDescription,
  RetrieveWithFiltersOpDescription,
  ValidateCitationsOpDescription,
} from "./descriptions";

// Side-effect import: installs the `wf.rag` accessor on Workflow.prototype.
import "./graph";
export { RAGNamespace } from "./graph";
export type {
  RAGNodeOptions,
  RAGRetrieveNodeOptions,
  RAGRetrieveWithFiltersNodeOptions,
} from "./graph";
