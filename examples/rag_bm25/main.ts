import { join } from "node:path";
import { Workflow, rag, ai } from "../../src";
import { loadKb, buildRagPrompt, parseCitations, retrievedSources } from "../rag-common";
import { runDualMode } from "../common";

export class BM25Retriever implements rag.Retriever {
  private docs: rag.Document[];
  constructor(docs: rag.Document[]) { this.docs = docs; }
  async retrieve(query: string, k: number): Promise<rag.Document[]> {
    const terms = query.toLowerCase().split(/\W+/).filter(t => t);
    const scored = this.docs.map(d => {
        let score = 0;
        const content = d.content.toLowerCase();
        for (const t of terms) if (content.includes(t)) score++;
        return { ...d, score };
    }).filter(d => d.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
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
  try {
      const docs = loadKb(kbDir);
      rag.setDefaultRetriever(new BM25Retriever(docs));
  } catch {}

  runDualMode(build, {
    name: "rag_bm25",
    inputMapping: { question: "question" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
