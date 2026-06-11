/**
 * S4a · RAG op surface: `wf.rag.*` node constructors (Finding A, RAG tail).
 * Mirrors S2's `wf.ai.*` pattern — retrieval ops take input nodes and return
 * output nodes, the engine supplies `ctx`, and a single `name` flows through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Workflow } from "../src";
import {
  setDefaultRetriever,
  type Document,
  type Retriever,
  type RetrievalContext,
} from "../src/rag";

/** Records each call and returns a fixed doc set (best-first). */
class StubRetriever implements Retriever {
  readonly calls: { query: string; k: number; filters?: Record<string, string> }[] = [];
  constructor(private readonly docs: Document[] = []) {}
  async retrieve(query: string, k: number, ctx: RetrievalContext): Promise<Document[]> {
    this.calls.push({ query, k, filters: ctx.filters?.values() });
    return this.docs.slice(0, Math.min(k, this.docs.length)).map((d) => ({ ...d }));
  }
}

const doc = (id: string, content: string): Document => ({ id, content, score: 1 });

test("wf.rag.retrieve wires an input node to an output node (Finding A)", async () => {
  const stub = new StubRetriever([doc("a", "alpha"), doc("b", "beta")]);
  setDefaultRetriever(stub);
  try {
    const wf = new Workflow();
    const query = wf.input<string>("query");
    // No wf.op wrapper, no ctx couriering, input declared once.
    const docs = wf.rag.retrieve(query, { k: 1, name: "retrieve" });
    const top = wf.op({ docs }, ({ docs }) => docs.texts[0]);

    const r = await wf.run({ values: { query: "find alpha" } });
    assert.deepEqual(r.get(docs).texts, ["alpha"]);
    assert.equal(r.get(top), "alpha");
    assert.deepEqual(stub.calls, [{ query: "find alpha", k: 1, filters: undefined }]);
  } finally {
    setDefaultRetriever(null);
  }
});

test("wf.rag is memoized per workflow and absent across instances", () => {
  const wf = new Workflow();
  assert.equal(wf.rag, wf.rag);
  assert.notEqual(wf.rag, new Workflow().rag);
});

test("the node name is the reasoning/introspection label — one name (Finding D-style)", async () => {
  setDefaultRetriever(new StubRetriever([doc("a", "alpha")]));
  try {
    const wf = new Workflow();
    const query = wf.input<string>("query");
    wf.rag.retrieve(query, { name: "kb_lookup" });

    const r = await wf.run({ values: { query: "x" } });
    assert.ok(r.firedNodes().some((n) => n.name === "kb_lookup"));
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters merges static + runtime filters from a node", async () => {
  const stub = new StubRetriever([doc("a", "alpha")]);
  setDefaultRetriever(stub);
  try {
    const wf = new Workflow();
    const query = wf.input<string>("query");
    const filters = wf.constant<Record<string, string>>({ tenant: "acme" });
    const docs = wf.rag.retrieveWithFilters(query, filters, {
      staticFilters: { lang: "en" },
      name: "scoped",
    });

    const r = await wf.run({ values: { query: "x" } });
    assert.deepEqual(r.get(docs).texts, ["alpha"]);
    // runtime wins on collision; both keys merged.
    assert.deepEqual(stub.calls[0]!.filters, { lang: "en", tenant: "acme" });
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters with no filters node uses static filters only", async () => {
  const stub = new StubRetriever([doc("a", "alpha")]);
  setDefaultRetriever(stub);
  try {
    const wf = new Workflow();
    const query = wf.input<string>("query");
    const docs = wf.rag.retrieveWithFilters(query, undefined, {
      staticFilters: { lang: "en" },
    });

    const r = await wf.run({ values: { query: "x" } });
    assert.deepEqual(r.get(docs).texts, ["alpha"]);
    assert.deepEqual(stub.calls[0]!.filters, { lang: "en" });
  } finally {
    setDefaultRetriever(null);
  }
});

test("a skipped runtime-filters node skips retrieval (it is a real dependency)", async () => {
  setDefaultRetriever(new StubRetriever([doc("a", "alpha")]));
  try {
    const wf = new Workflow();
    const query = wf.input<string>("query");
    const filters = wf.op({}, () => ({}) as Record<string, string>, {
      name: "filters_src",
      condition: () => false, // never produces → skips
    });
    const docs = wf.rag.retrieveWithFilters(query, filters, { name: "scoped" });

    const r = await wf.run({ values: { query: "x" } });
    assert.equal(r.skipped(docs), true);
  } finally {
    setDefaultRetriever(null);
  }
});

test("wf.rag.validateCitations filters raw citations against an allow-list", async () => {
  const wf = new Workflow();
  const raw = wf.constant<string[]>(["a.md", "evil.md", "a.md", "b.md"]);
  const allowed = wf.constant<string[]>(["a.md", "b.md"]);
  const result = wf.rag.validateCitations(raw, allowed, { name: "cite_check" });

  const r = await wf.run({});
  assert.deepEqual(r.get(result), { accepted: ["a.md", "b.md"], rejected: ["evil.md"] });
  assert.ok(r.firedNodes().some((n) => n.name === "cite_check"));
});
