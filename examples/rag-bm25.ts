/**
 * RAG example — retrieval-augmented generation over a small local knowledge base
 * with source-file citations, retrieved by an in-memory BM25 index.
 *
 * Faithful port of sparsi-go examples/rag-bm25 (main.go + bm25.go). On startup it
 * loads every .txt file under testdata/kb/, tags each Document with
 * Metadata[source] = filename, indexes them with a BM25 retriever, and registers
 * it as the process default. The graph is the same shape as the Go original:
 *
 *   question ─► retrieve (k=3) ─► documents ─┬─► build_rag_prompt ─► answer (AI) ─► parse_citations ─┐
 *                                            ├─► retrieved_sources ─────────────────────────────────┴─► validate_citations
 *                                            └─► (passages, for the stderr trace)
 *
 * RetrieveOp pulls the top-3 documents; build_rag_prompt formats them into one
 * prompt (each passage labelled by source filename, XML-escaped) instructing the
 * LLM to end with a "Sources: <filenames>" trailer; an AI string→string op
 * answers; parse_citations splits the answer into body + cited filenames;
 * validate_citations filters those citations against the *retrieved* sources
 * (dropping hallucinations). The shared prompt/citation helpers live in
 * rag-common.ts.
 *
 * The Go `-mcp` stdio-server wrapper is intentionally omitted (§6g: optional);
 * this is a clean CLI entry point over the same analysis DAG.
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY).
 *   npm run example:rag-bm25 -- --question "how do I return an item?"
 *   npm run example:rag-bm25 -- --question "is my heat pump supported?" --kb examples/testdata/kb
 */
import { join } from "node:path";
import { Workflow, ai, rag } from "../src";
import { buildRagPrompt, loadKb, parseCitations, retrievedSources, sourceFilename } from "./rag-common";

const ANSWER_OP =
  "answer the question grounded in the provided context, then cite the source filenames you used";
const MODEL = "claude-sonnet-4-6";

// ─── BM25 retriever ─────────────────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Lowercases the input and splits on any rune that isn't a letter or digit. No
 * stemming, no stopword removal — BM25's IDF weighting handles common words.
 */
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{Nd}]+/u)
    .filter((t) => t !== "");
}

/**
 * In-memory {@link rag.Retriever} using the classic Robertson/Sparck-Jones BM25
 * ranking function. The corpus is indexed at construction and immutable
 * afterward; Retrieve is read-only, so concurrent calls are safe. Suitable up to
 * ~10k documents — plug in an external search backend for larger corpora.
 */
export class BM25Retriever implements rag.Retriever {
  private readonly docs: rag.Document[];
  private readonly termFreq: Map<string, number>[];
  private readonly docLen: number[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  constructor(docs: rag.Document[]) {
    this.docs = docs;
    this.termFreq = new Array(docs.length);
    this.docLen = new Array(docs.length);
    let totalLen = 0;
    for (let i = 0; i < docs.length; i++) {
      const toks = tokenize(docs[i]!.content);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.termFreq[i] = tf;
      this.docLen[i] = toks.length;
      totalLen += toks.length;
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgdl = docs.length > 0 ? totalLen / docs.length : 0;
  }

  async retrieve(query: string, k: number, _ctx: rag.RetrievalContext): Promise<rag.Document[]> {
    const qTerms = tokenize(query);
    if (qTerms.length === 0 || this.docs.length === 0) return [];
    const n = this.docs.length;

    const scored: rag.Document[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      let score = 0;
      const dl = this.docLen[i]!;
      for (const qt of qTerms) {
        const f = this.termFreq[i]!.get(qt) ?? 0;
        if (f === 0) continue;
        const df = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const tf = f;
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / this.avgdl);
        score += (idf * tf * (BM25_K1 + 1)) / denom;
      }
      if (score > 0) {
        scored.push({ ...this.docs[i]!, score });
      }
    }
    // Array.prototype.sort is stable (ES2019+), matching Go's sort.SliceStable.
    scored.sort((a, b) => b.score - a.score);
    return k < scored.length ? scored.slice(0, k) : scored;
  }
}

// ─── Graph ──────────────────────────────────────────────────────────────────

function build() {
  const wf = new Workflow();
  const question = wf.input<string>("question");

  // Top-3 retrieval (BM25, registered as the process default).
  const retrieved = wf.op({ question }, ({ question }, ctx) => rag.retrieve(question, { k: 3 }, ctx), {
    name: "retrieve",
  });
  const documents = wf.op({ retrieved }, ({ retrieved }) => retrieved.documents, {
    name: "documents",
  });

  // Format the RAG prompt + derive the citation allow-list (retrieved sources).
  const prompt = wf.op({ question, documents }, ({ question, documents }) =>
    buildRagPrompt(question, documents), { name: "build_rag_prompt" });
  const allowedSources = wf.op({ documents }, ({ documents }) => retrievedSources(documents), {
    name: "retrieved_sources",
  });

  // AI answer, then split into body + cited filenames.
  const rawAnswer = wf.op({ prompt }, ({ prompt }, ctx) =>
    ai.aiCompute<string>(prompt, { operation: ANSWER_OP, output: "string", model: MODEL, name: "answer" }, ctx),
    { name: "answer" });
  const parsed = wf.op({ rawAnswer }, ({ rawAnswer }) => parseCitations(rawAnswer), {
    name: "parse_citations",
  });
  const body = wf.op({ parsed }, ({ parsed }) => parsed.body, { name: "body" });
  const citedSources = wf.op({ parsed }, ({ parsed }) => parsed.sources, { name: "sources" });

  // Citation validity: only sources that were actually retrieved survive.
  const validated = wf.op({ citedSources, allowedSources }, ({ citedSources, allowedSources }) =>
    rag.validateCitations(citedSources, allowedSources), { name: "validate_citations" });

  return { wf, documents, body, validated };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

interface Args {
  question?: string;
  kb?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--question") out.question = argv[++i];
    else if (argv[i] === "--kb") out.kb = argv[++i];
  }
  return out;
}

async function main(): Promise<void> {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (!args.question || args.question.trim() === "") {
    console.error('usage: rag-bm25 --question "<your question>" [--kb <dir>]');
    process.exit(2);
  }

  const kbDir = args.kb ?? join(__dirname, "testdata", "kb");
  const docs = loadKb(kbDir);
  rag.setDefaultRetriever(new BM25Retriever(docs));

  const { wf, documents, body, validated } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { question: args.question },
    concurrency: 10,
  });

  const retrieved = result.get(documents);
  if (retrieved.length > 0) {
    process.stderr.write("Retrieved passages:\n");
    for (const d of retrieved) {
      process.stderr.write(`  [${sourceFilename(d)}] score=${d.score.toFixed(3)}\n`);
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
