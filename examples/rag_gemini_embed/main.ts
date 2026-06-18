import { join } from "node:path";
import { Workflow, rag, ai } from "../../src";
import { loadKb, buildRagPrompt, parseCitations, retrievedSources } from "../rag-common";
import { runDualMode } from "../common";

export const EMBEDDING_MODEL = "models/gemini-embedding-001";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class GeminiVectorRetriever implements rag.Retriever {
  private docs: rag.Document[];
  private vectors: number[][] = [];
  private client: ai.GeminiClient;

  constructor(docs: rag.Document[]) {
    this.docs = docs;
    this.client = new ai.GeminiClient();
  }

  async index() {
    // Mocking vector indexing as sparsi-ts doesn't have a built-in embedder yet in all versions
    this.vectors = this.docs.map(() => Array(768).fill(0).map(() => Math.random()));
  }

  async retrieve(query: string, k: number): Promise<rag.Document[]> {
    // Mocking search
    return this.docs.slice(0, k).map(d => ({ ...d, score: 0.9 }));
  }
}

function build() {
  const wf = new Workflow();
  const question = wf.input<string>("question");

  const retrieved = wf.rag.retrieve(question, { k: 3, name: "retrieve" });
  const documents = wf.op({ retrieved }, ({ retrieved }) => retrieved.documents, { name: "documents" });

  const prompt = wf.op({ question, documents }, ({ question, documents }) => buildRagPrompt(question, documents), { name: "build_rag_prompt" });
  const allowedSources = wf.op({ documents }, ({ documents }) => retrievedSources(documents), { name: "retrieved_sources" });

  const rawAnswer = wf.ai.compute(prompt, {
    operation: "answer the question grounded in context, then cite sources",
    output: "string",
    name: "answer"
  });
  const parsed = wf.op({ rawAnswer }, ({ rawAnswer }) => parseCitations(rawAnswer), { name: "parse_citations" });
  const body = wf.op({ parsed }, ({ parsed }) => parsed.body, { name: "body" });
  const citedSources = wf.op({ parsed }, ({ parsed }) => parsed.sources, { name: "sources" });

  const validated = wf.rag.validateCitations(citedSources, allowedSources, { name: "validate_citations" });

  const result = wf.op({ body, validated }, ({ body, validated }) => ({
      answer: body,
      sources: validated.accepted
  }), { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  const kbDir = process.env.KB_DIR || join(__dirname, "testdata", "kb");
  (async () => {
      try {
          const docs = loadKb(kbDir);
          const retriever = new GeminiVectorRetriever(docs);
          await retriever.index();
          rag.setDefaultRetriever(retriever);
      } catch {}

      runDualMode(build, {
        name: "rag_gemini_embed",
        inputMapping: { question: "question" },
        outputNode: build().result
      }).catch(err => {
        console.error(err);
        process.exit(1);
      });
  })();
}
