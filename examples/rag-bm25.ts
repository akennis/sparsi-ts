/**
 * RAG example — retrieval-augmented generation over a small local knowledge base
 * with source-file citations, retrieved by an in-memory BM25 index.
 *
 * On startup it loads every .txt file under testdata/kb/, tags each Document with
 * Metadata[source] = filename, indexes them with a BM25 retriever, and registers
 * it as the process default. The graph shape:
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
 * A clean CLI entry point over the analysis DAG.
 *
 * Requires CLAUDE_API_KEY (or ANTHROPIC_API_KEY). With no args it answers a
 * default "how do I return an item?" question.
 *   npm run example:rag-bm25                                  # default question
 *   npm run example:rag-bm25 -- --question "how do I return an item?"
 *   npm run example:rag-bm25 -- --question "is my heat pump supported?" --kb examples/testdata/kb
 */
import { join } from "node:path";
import { parseArgs } from "node:util";
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

/** One indexed document: its term-frequency map and total token length. */
interface IndexedDoc {
  doc: rag.Document;
  len: number;
  tf: Map<string, number>;
}

/**
 * In-memory {@link rag.Retriever} using the classic Robertson/Sparck-Jones BM25
 * ranking function. The corpus is indexed at construction and immutable
 * afterward; Retrieve is read-only, so concurrent calls are safe. Suitable up to
 * ~10k documents — plug in an external search backend for larger corpora.
 */
export class BM25Retriever implements rag.Retriever {
  private readonly index: IndexedDoc[];
  private readonly df = new Map<string, number>();
  private readonly avgdl: number;

  constructor(docs: rag.Document[]) {
    this.index = docs.map((doc) => {
      const tf = new Map<string, number>();
      let len = 0;
      for (const t of tokenize(doc.content)) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        len++;
      }
      return { doc, len, tf };
    });
    for (const { tf } of this.index) {
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    const totalLen = this.index.reduce((sum, d) => sum + d.len, 0);
    this.avgdl = this.index.length > 0 ? totalLen / this.index.length : 0;
  }

  async retrieve(query: string, k: number, _ctx: rag.RetrievalContext): Promise<rag.Document[]> {
    const qTerms = tokenize(query);
    if (qTerms.length === 0 || this.index.length === 0) return [];
    const n = this.index.length;

    const scored: rag.Document[] = [];
    for (const { doc, len, tf } of this.index) {
      let score = 0;
      for (const qt of qTerms) {
        const f = tf.get(qt) ?? 0;
        if (f === 0) continue;
        const df = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * len) / this.avgdl);
        score += (idf * f * (BM25_K1 + 1)) / denom;
      }
      if (score > 0) {
        scored.push({ ...doc, score });
      }
    }
    // Array.prototype.sort is stable (ES2019+), so equal scores keep input order.
    scored.sort((a, b) => b.score - a.score);
    return k < scored.length ? scored.slice(0, k) : scored;
  }
}

// ─── Graph ──────────────────────────────────────────────────────────────────

function build() {
  const wf = new Workflow();
  const question = wf.input<string>("question");

  // Top-3 retrieval (BM25, registered as the process default).
  const retrieved = wf.rag.retrieve(question, { k: 3, name: "retrieve" });
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
  const rawAnswer = wf.ai.compute(prompt, {
    operation: ANSWER_OP,
    output: "string",
    model: MODEL,
    name: "answer",
  });
  const parsed = wf.op({ rawAnswer }, ({ rawAnswer }) => parseCitations(rawAnswer), {
    name: "parse_citations",
  });
  const body = wf.op({ parsed }, ({ parsed }) => parsed.body, { name: "body" });
  const citedSources = wf.op({ parsed }, ({ parsed }) => parsed.sources, { name: "sources" });

  // Citation validity: only sources that were actually retrieved survive.
  const validated = wf.rag.validateCitations(citedSources, allowedSources, {
    name: "validate_citations",
  });

  return { wf, documents, body, validated };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.CLAUDE_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is required");
    process.exit(1);
  }
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      question: { type: "string" },
      kb: { type: "string" },
    },
  });
  // Default question (matches the KB's returns.txt) so the example runs with no args.
  const question = values.question?.trim() ? values.question : "how do I return an item?";

  const kbDir = values.kb ?? join(__dirname, "testdata", "kb");
  const docs = loadKb(kbDir);
  rag.setDefaultRetriever(new BM25Retriever(docs));

  const { wf, documents, body, validated } = build();
  const result = await wf.run({
    ai: new ai.AnthropicClient(),
    values: { question },
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

// Unlike the other examples (which call `main().catch(...)` unconditionally),
// this entry is guarded: rag-bm25.test.ts imports `BM25Retriever` from this
// module, and the guard keeps that import from running the CLI driver. The
// package is CommonJS, so `require.main === module` is the right idiom here.
if (require.main === module) {
  main().catch((err) => {
    console.error("workflow:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
