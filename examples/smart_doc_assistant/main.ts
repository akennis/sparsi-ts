import { Workflow, rag } from "../../src";
import { runDualMode } from "../common";

function build(verbose: boolean) {
  const wf = new Workflow();
  const query = wf.input<string>("query");

  const categories = wf.constant(["api", "auth", "deployment", "troubleshooting"], "categories");

  const classification = wf.ai.classifyMultiLabel(query, {
    categories: ["api", "auth", "deployment", "troubleshooting"],
    name: "classify"
  });

  const retrieved = wf.rag.retrieve(query, {
    k: 5,
    name: "retrieve",
    // In a real app, you'd pass filters derived from classification here.
  });

  const documents = wf.op({ retrieved }, ({ retrieved }) => retrieved.documents, { name: "documents" });
  const docContents = wf.op({ documents }, ({ documents }) => documents.map(d => d.content), { name: "doc_contents" });

  const rerankedIndices = wf.ai.rerank(query, docContents, {
    name: "rerank"
  });

  const context = wf.op({ documents, indices: rerankedIndices }, ({ documents, indices }) => {
    return indices.slice(0, 3).map(i => {
      const d = documents[i]!;
      const source = d.metadata?.[rag.MetadataSource] ?? `doc${i}.md`;
      return `<document id="${source}">\n${d.content}\n</document>`;
    }).join("\n\n");
  }, { name: "prepare_context" });

  const answer = wf.ai.compute(query, {
    operation: "Answer the query based on the provided context. Cite your sources using [doc_id] format.",
    output: "string",
    formatInput: (q) => `Query: ${q}\n\nContext:\n${wf.definitions.get(context.id)}`, // This is wrong, needs to be dynamic
    // Wait, ai.compute doesn't easily support multi-input prompts in a way that includes the context wire.
    // I should use wf.op to format the prompt first.
    name: "answer_raw"
  });

  // Let's fix the prompt construction
  const prompt = wf.op({ query, context }, ({ query, context }) => {
    return `Answer the following query using ONLY the provided context.\n\nQuery: ${query}\n\nContext:\n${context}\n\nCite sources as [doc_id].`;
  }, { name: "format_prompt" });

  const finalAnswer = wf.ai.compute(prompt, {
    operation: "Answer grounded in context with citations.",
    output: "string",
    name: "answer"
  });

  const parsed = wf.op({ answer: finalAnswer }, ({ answer }) => {
    // Assuming a simple extraction for the mock: finding all [docX.md]
    const matches = Array.from(answer.matchAll(/\[(.*?)\]/g));
    return matches.map(m => m[1]).filter(s => s !== undefined) as string[];
  }, { name: "parse_citations" });

  const allowedSources = wf.op({ documents }, ({ documents }) => documents.map(d => d.metadata?.[rag.MetadataSource] ?? d.id) as string[], { name: "allowed_sources" });

  const validation = wf.rag.validateCitations(parsed, allowedSources, {
    name: "validate"
  });

  const result = wf.op({ answer: finalAnswer, validation }, ({ answer, validation }) => {
    return {
      answer,
      valid: validation.rejected.length === 0,
      hallucinated: validation.rejected
    };
  }, { name: "final_result" });

  return { wf, result };
}

// I need to mock a retriever for the example to work without a real vector store
class MockRetriever implements rag.Retriever {
  async retrieve(query: string, k: number): Promise<rag.Document[]> {
    return [
      { id: "1", content: `Information about ${query}`, score: 1.0, metadata: { [rag.MetadataSource]: "doc1.md" } },
      { id: "2", content: `More details on ${query}`, score: 0.9, metadata: { [rag.MetadataSource]: "doc2.md" } },
    ];
  }
}

if (require.main === module) {
  rag.setDefaultRetriever(new MockRetriever());
  
  runDualMode(() => build(true), {
    name: "smart_doc_assistant",
    inputMapping: { query: "query" },
    outputNode: build(true).result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
