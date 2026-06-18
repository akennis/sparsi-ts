import { Workflow, rag } from "../../src";
import { runDualMode } from "../common";

function build() {
  const wf = new Workflow();
  const query = wf.input<string>("query");

  const retrieved = wf.rag.retrieve(query, { k: 2, name: "retrieve" });
  
  const prompt = wf.op({ query, retrieved }, ({ query, retrieved }) => {
      const docs = retrieved.documents.map(d => `[${d.metadata?.[rag.MetadataSource] ?? d.id}]\n${d.content}`).join("\n\n");
      return `Answer the following query using ONLY the provided context.\n\nQuery: ${query}\n\nContext:\n${docs}\n\nCite your sources using [filename.md] format.`;
  }, { name: "format_prompt" });

  const answer = wf.ai.compute(prompt, {
    operation: "Answer grounded in context with citations.",
    output: "string",
    name: "answer"
  });

  const parsedSources = wf.op({ answer }, ({ answer }) => {
    const matches = Array.from(answer.matchAll(/\[(.*?)\]/g));
    return matches.map(m => m[1]).filter(s => s !== undefined) as string[];
  }, { name: "parse_citations" });

  const documents = wf.op({ retrieved }, ({ retrieved }) => retrieved.documents, { name: "documents" });
  const allowedSources = wf.op({ documents }, ({ documents }) => documents.map(d => d.metadata?.[rag.MetadataSource] ?? d.id) as string[], { name: "allowed_sources" });
  
  const validation = wf.rag.validateCitations(parsedSources, allowedSources, { name: "validate" });

  const result = wf.op({ answer, validation }, ({ answer, validation }) => {
      let final = answer;
      if (validation.rejected.length > 0) {
          final += `\n\n[Warning: Invalid citations: ${validation.rejected.join(", ")}]`;
      }
      return final;
  }, { name: "final_result" });

  return { wf, result };
}

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
  
  runDualMode(build, {
    name: "rag_basic",
    inputMapping: { query: "query" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
