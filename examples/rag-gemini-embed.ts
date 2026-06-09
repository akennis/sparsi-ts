/**
 * RAG example — retrieval-augmented generation over a small local knowledge base
 * using Gemini embeddings + cosine similarity for retrieval, with source-file
 * citations.
 *
 * Faithful port of sparsi-go examples/rag-gemini-embed (main.go +
 * embed_retriever.go). On startup it loads every .txt file under testdata/kb/,
 * tags each Document with Metadata[source] = filename, embeds the corpus via the
 * framework's embedding-factory abstraction (rag.resolveEmbeddingClient — the
 * bundled gemini-only EnvEmbeddingClientFactory reads GEMINI_API_KEY), and
 * registers the resulting cosine retriever as the process default.
 *
 * The graph is identical in shape to rag-bm25 (retrieve → build prompt + derive
 * allow-list → AI answer → parse citations → validate citations); only the
 * retriever differs. The point of this example is the credential plumbing: a
 * vector-store-backed Retriever consumes the EmbeddingClientFactory the same way
 * AI ops consume the AIClientFactory, including per-request credential routing
 * via the embedding credentials installed on the RetrievalContext. Swap Gemini
 * for any other embedder by registering a custom EmbeddingClientFactory and
 * calling ctx.resolveEmbeddingClient("<provider>", "<model>") inside Retrieve.
 *
 * The shared prompt/citation helpers live in rag-common.ts. The Go `-mcp`
 * stdio-server wrapper is intentionally omitted (§6g: optional).
 *
 * Requires GEMINI_API_KEY (to embed the KB + query) and CLAUDE_API_KEY (or
 * ANTHROPIC_API_KEY) for the answer op.
 *   npm run example:rag-gemini-embed -- --question "how do I return an item?"
 */
import { join } from "node:path";
import { Workflow, ai, rag } from "../src";
import { buildRagPrompt, loadKb, parseCitations, retrievedSources, sourceFilename } from "./rag-common";

const ANSWER_OP =
  "answer the question grounded in the provided context, then cite the source filenames you used";
const MODEL = "claude-sonnet-4-6";
export const EMBEDDING_MODEL = "gemini-embedding-001";

// ─── Gemini-embedding retriever ─────────────────────────────────────────────

/**
 * cosine similarity = dot(a,b) / (|a|·|b|) in [-1, 1]. Returns 0 when either
 * vector is zero-length / mismatched-length / zero-norm so the score is
 * well-defined for degenerate inputs.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory {@link rag.Retriever} that ranks documents by cosine similarity
 * between Gemini embeddings of the query and each KB passage. Embeddings come
 * from the framework's embedding-factory abstraction; the retriever never reads
 * env vars itself — that is the point of the credential plumbing. The corpus is
 * immutable after {@link create} returns, so concurrent Retrieve calls are safe.
 */
export class GeminiVectorRetriever implements rag.Retriever {
  private constructor(
    private readonly docs: rag.Document[],
    private readonly vectors: number[][],
    private readonly model: string,
    private readonly indexClient: rag.EmbeddingClient,
  ) {}

  /**
   * Embeds every doc up-front using rag.resolveEmbeddingClient. Pass the default
   * (no credentials) to use the process-default EmbeddingClientFactory, or
   * install routing via the embedding credentials for per-tenant setups. Throws
   * if no documents are supplied, the model is empty, the embedding client can't
   * be resolved, or the API rejects the indexing batch.
   */
  static async create(
    docs: rag.Document[],
    model: string,
    signal?: AbortSignal,
  ): Promise<GeminiVectorRetriever> {
    if (docs.length === 0) {
      throw new Error("GeminiVectorRetriever: no documents to index");
    }
    if (model === "") {
      throw new Error("GeminiVectorRetriever: empty model");
    }
    let client: rag.EmbeddingClient;
    try {
      client = await rag.resolveEmbeddingClient(undefined, "gemini", model, signal);
    } catch (err) {
      throw new Error(
        `GeminiVectorRetriever: resolve embedding client: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const texts = docs.map((d) => d.content);
    let vectors: number[][];
    try {
      vectors = await client.embed(texts, signal);
    } catch (err) {
      throw new Error(
        `GeminiVectorRetriever: embed corpus: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (vectors.length !== docs.length) {
      throw new Error(
        `GeminiVectorRetriever: embedding count mismatch: got ${vectors.length}, want ${docs.length}`,
      );
    }
    return new GeminiVectorRetriever(docs, vectors, model, client);
  }

  async retrieve(query: string, k: number, ctx: rag.RetrievalContext): Promise<rag.Document[]> {
    if (query === "" || this.docs.length === 0) return [];
    const client = await this.queryClient(ctx);
    const qVecs = await client.embed([query], ctx.signal);
    if (qVecs.length !== 1) {
      throw new Error(`GeminiVectorRetriever: query embedding count = ${qVecs.length}, want 1`);
    }
    const qVec = qVecs[0]!;

    const scored: rag.Document[] = this.docs.map((d, i) => ({
      ...d,
      score: cosineSimilarity(qVec, this.vectors[i]!),
    }));
    // Array.prototype.sort is stable (ES2019+), matching Go's sort.SliceStable.
    scored.sort((a, b) => b.score - a.score);
    return k < scored.length ? scored.slice(0, k) : scored;
  }

  /**
   * Returns the cached indexing client when the request carries no
   * embedding-credential overrides; otherwise resolves a fresh client using
   * whatever credentials the request installed. Keeps the common single-tenant
   * case cheap while still honoring per-request routing.
   */
  private queryClient(ctx: rag.RetrievalContext): Promise<rag.EmbeddingClient> | rag.EmbeddingClient {
    const creds = ctx.embeddingCredentials;
    if ((!creds || (creds.ref === "" && creds.factoryId === "")) && this.indexClient) {
      return this.indexClient;
    }
    return ctx.resolveEmbeddingClient("gemini", this.model);
  }
}

// ─── Graph ──────────────────────────────────────────────────────────────────

function build() {
  const wf = new Workflow();
  const question = wf.input<string>("question");

  const retrieved = wf.op({ question }, ({ question }, ctx) => rag.retrieve(question, { k: 3 }, ctx), {
    name: "retrieve",
  });
  const documents = wf.op({ retrieved }, ({ retrieved }) => retrieved.documents, {
    name: "documents",
  });

  const prompt = wf.op({ question, documents }, ({ question, documents }) =>
    buildRagPrompt(question, documents), { name: "build_rag_prompt" });
  const allowedSources = wf.op({ documents }, ({ documents }) => retrievedSources(documents), {
    name: "retrieved_sources",
  });

  const rawAnswer = wf.op({ prompt }, ({ prompt }, ctx) =>
    ai.aiCompute<string>(prompt, { operation: ANSWER_OP, output: "string", model: MODEL, name: "answer" }, ctx),
    { name: "answer" });
  const parsed = wf.op({ rawAnswer }, ({ rawAnswer }) => parseCitations(rawAnswer), {
    name: "parse_citations",
  });
  const body = wf.op({ parsed }, ({ parsed }) => parsed.body, { name: "body" });
  const citedSources = wf.op({ parsed }, ({ parsed }) => parsed.sources, { name: "sources" });

  const validated = wf.op({ citedSources, allowedSources }, ({ citedSources, allowedSources }) =>
    rag.validateCitations(citedSources, allowedSources), { name: "validate_citations" });

  return { wf, documents, body, validated };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

interface Args {
  question?: string;
  kb?: string;
  indexTimeoutMs?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--question") out.question = argv[++i];
    else if (argv[i] === "--kb") out.kb = argv[++i];
    else if (argv[i] === "--index-timeout-ms") out.indexTimeoutMs = Number(argv[++i]);
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is required (to embed the knowledge base and query)");
    process.exit(1);
  }
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required for the answer op");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  // Mirror the Go default question so the example runs with no flags.
  const question = args.question ?? "how do I return an item?";
  if (question.trim() === "") {
    console.error('usage: rag-gemini-embed --question "<your question>" [--kb <dir>]');
    process.exit(2);
  }

  const kbDir = args.kb ?? join(__dirname, "testdata", "kb");
  const docs = loadKb(kbDir);

  const indexTimeoutMs = args.indexTimeoutMs ?? 30_000;
  const indexController = new AbortController();
  const indexTimer = setTimeout(() => indexController.abort(), indexTimeoutMs);
  process.stderr.write(
    `rag-gemini-embed.indexing doc_count=${docs.length} model=${EMBEDDING_MODEL}\n`,
  );
  let retriever: GeminiVectorRetriever;
  try {
    retriever = await GeminiVectorRetriever.create(docs, EMBEDDING_MODEL, indexController.signal);
  } finally {
    clearTimeout(indexTimer);
  }
  rag.setDefaultRetriever(retriever);

  const { wf, documents, body, validated } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { question },
    concurrency: 10,
  });

  const retrievedDocs = result.get(documents);
  if (retrievedDocs.length > 0) {
    process.stderr.write("Retrieved passages:\n");
    for (const d of retrievedDocs) {
      process.stderr.write(`  [${sourceFilename(d)}] cosine=${d.score.toFixed(3)}\n`);
    }
  }

  const { accepted, rejected } = result.get(validated);
  for (const s of rejected) {
    process.stderr.write(`WARNING: dropping hallucinated source: ${s}\n`);
  }

  console.log(result.get(body));
  if (accepted.length > 0) {
    console.log();
    console.log("Sources: " + accepted.join(", "));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("workflow:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
