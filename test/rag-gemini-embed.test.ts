/**
 * Tests for the rag-gemini-embed example — behavioral parity with the Go
 * package's embed_retriever_test.go.
 *
 * A fake EmbeddingClientFactory maps text to a deterministic, L2-normalized
 * bag-of-words vector (FNV-1a hash buckets, stopwords filtered). Cosine
 * similarity over those vectors tracks token overlap closely enough to assert
 * retrieval ordering on the same FAQ corpus the BM25 example uses — without any
 * network or GEMINI_API_KEY.
 *
 * The shared prompt-building / citation-parsing / retrieved-sources helpers
 * (examples/rag-common.ts) are covered once in rag-bm25.test.ts and are NOT
 * re-tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  cosineSimilarity,
  GeminiVectorRetriever,
  EMBEDDING_MODEL,
} from "../examples/rag-gemini-embed";
import { loadKb } from "../examples/rag-common";
import {
  registerEmbeddingClientFactory,
  resolveEmbeddingClient,
  setDefaultEmbeddingClientFactory,
} from "../src/rag";
import type {
  EmbeddingClient,
  EmbeddingClientFactory,
  EmbeddingCredentials,
  RetrievalContext,
} from "../src/rag";

const KB_DIR = join(__dirname, "..", "examples", "testdata", "kb");

// ─── Fake bag-of-words embedding factory ────────────────────────────────────

/** FNV-1a 32-bit over the UTF-8 bytes of `s` (mirrors Go's hash/fnv New32a). */
function fnv1a32(s: string): number {
  let hash = 0x811c9dc5; // 2166136261
  for (const b of new TextEncoder().encode(s)) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0; // *16777619, keep unsigned 32-bit
  }
  return hash >>> 0;
}

// Same stopword set as the Go test, so common-word noise doesn't drown the signal.
const STOPWORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "has", "have", "how", "i", "in", "is", "it", "its", "of", "on", "or",
  "so", "that", "the", "this", "to", "us", "was", "we", "what", "when", "where",
  "which", "who", "why", "will", "with", "you", "your", "my", "me", "if", "any",
  "all", "no",
]);

function bagOfWordsVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{Nd}]+/u)
    .filter((t) => t !== "");
  for (const tok of tokens) {
    if (STOPWORDS.has(tok)) continue;
    v[fnv1a32(tok) % dim]! += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  if (norm === 0) return v;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i]! *= inv;
  return v;
}

/**
 * Hands out clients that embed via {@link bagOfWordsVector}. `calls` counts the
 * total number of texts embedded across every client it produced (matching the
 * Go factory's shared atomic counter).
 */
class FakeEmbeddingFactory implements EmbeddingClientFactory {
  calls = 0;
  constructor(private readonly dim: number) {}
  embedder(): EmbeddingClient {
    return {
      embed: async (texts: string[]) => {
        this.calls += texts.length;
        return texts.map((t) => bagOfWordsVector(t, this.dim));
      },
    };
  }
}

/**
 * Installs a fresh 4096-dim fake factory as the process default, runs `fn`, and
 * restores the default on the way out. dim is large so hash collisions are rare.
 */
async function withFakeEmbedder<T>(
  fn: (factory: FakeEmbeddingFactory) => Promise<T>,
): Promise<T> {
  const f = new FakeEmbeddingFactory(4096);
  setDefaultEmbeddingClientFactory(f);
  try {
    return await fn(f);
  } finally {
    setDefaultEmbeddingClientFactory(null);
  }
}

async function newTestRetriever(): Promise<GeminiVectorRetriever> {
  return GeminiVectorRetriever.create(loadKb(KB_DIR), EMBEDDING_MODEL);
}

function ctx(): RetrievalContext {
  const signal = new AbortController().signal;
  return {
    signal,
    resolveEmbeddingClient: (provider, model) =>
      resolveEmbeddingClient(undefined, provider, model, signal),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("GeminiVectorRetriever: indexing embeds the corpus exactly once per doc", async () => {
  await withFakeEmbedder(async (f) => {
    const docs = loadKb(KB_DIR);
    await GeminiVectorRetriever.create(docs, EMBEDDING_MODEL);
    assert.equal(f.calls, docs.length, "indexing must embed one text per doc");
  });
});

// The fake bag-of-words embedder is noisier than a real model (no IDF, hash
// collisions), so exact top-1 ordering is unstable. Assert the stronger
// structural property: the relevant doc is in the top-3 (out of 8).
test("GeminiVectorRetriever: the relevant doc appears in the top-3", async () => {
  await withFakeEmbedder(async () => {
    const r = await newTestRetriever();
    const cases: Array<{ query: string; wantID: string }> = [
      { query: "how do I return an item", wantID: "returns" },
      { query: "how long does shipping take", wantID: "shipping" },
      { query: "what does the warranty cover", wantID: "warranty" },
      { query: "how do I pair the thermostat with my phone", wantID: "setup" },
      { query: "can I pay with PayPal", wantID: "payments" },
      { query: "my display is blank", wantID: "troubleshooting" },
      { query: "is my heat pump supported", wantID: "compatibility" },
    ];
    for (const c of cases) {
      const docs = await r.retrieve(c.query, 3, ctx());
      assert.ok(docs.length > 0, `Retrieve returned no docs for ${JSON.stringify(c.query)}`);
      const ids = docs.map((d) => d.id);
      assert.ok(
        ids.includes(c.wantID),
        `query ${JSON.stringify(c.query)}: top-3 = ${ids.join(",")}, want ${c.wantID} in the set`,
      );
      assert.ok(docs[0]!.score > 0, `top hit Score = ${docs[0]!.score}, want > 0`);
    }
  });
});

test("GeminiVectorRetriever: scores decrease monotonically", async () => {
  await withFakeEmbedder(async () => {
    const r = await newTestRetriever();
    const docs = await r.retrieve("shipping warranty returns thermostat", 5, ctx());
    for (let i = 1; i < docs.length; i++) {
      assert.ok(
        docs[i]!.score <= docs[i - 1]!.score,
        `results not sorted: docs[${i}].Score=${docs[i]!.score} > docs[${i - 1}].Score=${docs[i - 1]!.score}`,
      );
    }
  });
});

test("GeminiVectorRetriever: k caps the number of results", async () => {
  await withFakeEmbedder(async () => {
    const r = await newTestRetriever();
    const docs = await r.retrieve("Tessera warranty thermostat", 2, ctx());
    assert.ok(docs.length <= 2, `k=2 returned ${docs.length} docs`);
  });
});

test("GeminiVectorRetriever: an empty query returns empty without calling the API", async () => {
  await withFakeEmbedder(async () => {
    const r = await newTestRetriever();
    const docs = await r.retrieve("", 5, ctx());
    assert.equal(docs.length, 0);
  });
});

test("GeminiVectorRetriever: concurrent retrieve is safe", async () => {
  await withFakeEmbedder(async () => {
    const r = await newTestRetriever();
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, () => r.retrieve("Tessera warranty", 3, ctx())),
    );
  });
});

test("GeminiVectorRetriever.create rejects an empty document set", async () => {
  await withFakeEmbedder(async () => {
    await assert.rejects(
      () => GeminiVectorRetriever.create([], EMBEDDING_MODEL),
      /no documents to index/,
    );
  });
});

test("GeminiVectorRetriever.create rejects an empty model", async () => {
  await withFakeEmbedder(async () => {
    const docs = loadKb(KB_DIR);
    await assert.rejects(() => GeminiVectorRetriever.create(docs, ""), /empty model/);
  });
});

// Index under the default fake factory, then install a tenant-scoped factory on
// the request ctx and verify the retriever resolves the per-request factory for
// the query embed (not the cached index client).
test("GeminiVectorRetriever: a ctx credentials override routes the query embed", async () => {
  await withFakeEmbedder(async (indexF) => {
    const r = await GeminiVectorRetriever.create(loadKb(KB_DIR), EMBEDDING_MODEL);
    const indexAfterBuild = indexF.calls;

    const tenantF = new FakeEmbeddingFactory(256);
    registerEmbeddingClientFactory("tenant-a", tenantF);
    try {
      const creds: EmbeddingCredentials = { ref: "", factoryId: "tenant-a", factoryTimeoutMs: 0 };
      const signal = new AbortController().signal;
      const reqCtx: RetrievalContext = {
        signal,
        embeddingCredentials: creds,
        resolveEmbeddingClient: (provider, model) =>
          resolveEmbeddingClient(creds, provider, model, signal),
      };
      const docs = await r.retrieve("shipping", 1, reqCtx);
      assert.equal(docs.length, 1);
      assert.equal(tenantF.calls, 1, "tenant factory must handle the query embed");
      assert.equal(
        indexF.calls,
        indexAfterBuild,
        "the index factory must not be called again after build",
      );
    } finally {
      registerEmbeddingClientFactory("tenant-a", null);
    }
  });
});

test("cosineSimilarity: known values", () => {
  const cases: Array<{ a: number[]; b: number[]; want: number }> = [
    { a: [1, 0, 0], b: [1, 0, 0], want: 1.0 },
    { a: [1, 0, 0], b: [0, 1, 0], want: 0.0 },
    { a: [1, 0, 0], b: [-1, 0, 0], want: -1.0 },
    { a: [0, 0, 0], b: [1, 2, 3], want: 0.0 },
    { a: [1, 1], b: [1, 1], want: 1.0 },
  ];
  for (const c of cases) {
    const got = cosineSimilarity(c.a, c.b);
    assert.ok(
      Math.abs(got - c.want) <= 1e-9,
      `cosineSimilarity(${c.a}, ${c.b}) = ${got}, want ${c.want}`,
    );
  }
});
