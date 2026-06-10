import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DeadlineExceededError,
  EnvEmbeddingClientFactory,
  GeminiEmbeddingClient,
  GEMINI_EMBEDDING_MAX_BATCH,
  MetadataSource,
  RetrievalFilters,
  isDeadlineExceeded,
  parseStaticFilters,
  registerEmbeddingClientFactory,
  registerRetriever,
  resolveEmbeddingClient,
  resolveEmbeddingFactory,
  retrieve,
  retrieveWithFilters,
  setDefaultEmbeddingClientFactory,
  setDefaultRetriever,
  validateCitations,
} from "../src/rag";
import type {
  Document,
  EmbeddingClient,
  EmbeddingClientFactory,
  EmbeddingCredentials,
  EmbedOnce,
  RetrievalContext,
  Retriever,
} from "../src/rag";

// A couple of edge cases don't apply to this typed API and are intentionally not
// tested:
//   - Malformed factory/embed timeout parsing: the options are typed `number`,
//     so there is no string to mis-parse (a negative embedTimeout is still
//     rejected, and that case IS tested below).
//   - Preserving pre-populated embedding credentials: the op carries no ambient
//     credential bag (creds are built from typed options), so there is nothing to
//     preserve.

// ─── Test doubles ──────────────────────────────────────────────────────────

interface StubCall {
  query: string;
  k: number;
  filters?: Record<string, string>;
  embeddingCredentials?: EmbeddingCredentials;
  embedCredsFound: boolean;
}

/** Records every retrieve call and returns a fixed (copied) slice of documents. */
class StubRetriever implements Retriever {
  readonly calls: StubCall[] = [];
  constructor(
    private readonly docs: Document[] = [],
    private readonly err?: Error,
  ) {}
  async retrieve(query: string, k: number, ctx: RetrievalContext): Promise<Document[]> {
    this.calls.push({
      query,
      k,
      filters: ctx.filters ? ctx.filters.values() : undefined,
      embeddingCredentials: ctx.embeddingCredentials,
      embedCredsFound: ctx.embeddingCredentials !== undefined,
    });
    if (this.err) throw this.err;
    const n = Math.min(k, this.docs.length);
    return this.docs.slice(0, n).map((d) => ({ ...d }));
  }
}

/** Blocks until its signal aborts, then rejects with the abort reason. */
class BlockingRetriever implements Retriever {
  retrieve(_query: string, _k: number, ctx: RetrievalContext): Promise<Document[]> {
    return new Promise((_resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(ctx.signal.reason);
        return;
      }
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true });
    });
  }
}

interface FactoryCall {
  provider: string;
  model: string;
  ref: string;
}

/** Records every embedder() call and returns a do-nothing client. */
class RecordingEmbeddingFactory implements EmbeddingClientFactory {
  readonly calls: FactoryCall[] = [];
  constructor(private readonly err?: Error) {}
  embedder(provider: string, model: string, ref: string): EmbeddingClient {
    this.calls.push({ provider, model, ref });
    if (this.err) throw this.err;
    return { embed: async () => [] };
  }
}

/** Blocks embedder() until its signal aborts, then rejects with the reason. */
class BlockingEmbeddingFactory implements EmbeddingClientFactory {
  embedder(
    _provider: string,
    _model: string,
    _ref: string,
    signal?: AbortSignal,
  ): Promise<EmbeddingClient> {
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

/** Records chunk sizes and encodes (callNumber, indexWithinCall) into vectors. */
class FakeEmbedOnce {
  readonly callSizes: number[] = [];
  constructor(private readonly errOnCall = new Map<number, Error>()) {}
  fn: EmbedOnce = async (texts) => {
    this.callSizes.push(texts.length);
    const call = this.callSizes.length;
    const err = this.errOnCall.get(call);
    if (err) throw err;
    return { embeddings: texts.map((_t, i) => ({ values: [call, i] })) };
  };
}

function captureWarn(fn: () => void | Promise<void>): Promise<string[]> {
  return (async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      await fn();
    } finally {
      console.warn = orig;
    }
    return warnings;
  })();
}

// ─── Retriever resolution ──────────────────────────────────────────────────

test("resolveRetriever falls back to the default when no id is set", async () => {
  const def = new StubRetriever();
  setDefaultRetriever(def);
  try {
    const r = await retrieve("q", {}, {});
    assert.equal(def.calls.length, 1);
    assert.deepEqual(r, { documents: [], texts: [] });
  } finally {
    setDefaultRetriever(null);
  }
});

test("resolveRetriever: a registered id wins over the default", async () => {
  const def = new StubRetriever([{ id: "def", content: "from default", score: 0 }]);
  const tenant = new StubRetriever([{ id: "ten", content: "from tenant", score: 0 }]);
  setDefaultRetriever(def);
  registerRetriever("kb-a", tenant);
  try {
    const { documents } = await retrieve("hello", { retrieverId: "kb-a" });
    assert.equal(documents.length, 1);
    assert.equal(documents[0]!.id, "ten");
    assert.equal(def.calls.length, 0, "default retriever must be bypassed for kb-a");
  } finally {
    registerRetriever("kb-a", null);
    setDefaultRetriever(null);
  }
});

test("resolveRetriever: an unknown id falls back to the default", async () => {
  const def = new StubRetriever([{ id: "def", content: "x", score: 0 }]);
  setDefaultRetriever(def);
  try {
    const { documents } = await retrieve("q", { retrieverId: "nope" });
    assert.equal(documents[0]!.id, "def");
  } finally {
    setDefaultRetriever(null);
  }
});

test("resolveRetriever throws fail-fast with no default and no id", async () => {
  setDefaultRetriever(null);
  await assert.rejects(() => retrieve("q"), /no default Retriever is set/);
});

test("resolveRetriever throws naming the id when unknown and no default", async () => {
  setDefaultRetriever(null);
  await assert.rejects(() => retrieve("q", { retrieverId: "missing" }), /missing/);
});

test("registerRetriever(id, null) deregisters", async () => {
  const def = new StubRetriever([{ id: "def", content: "x", score: 0 }]);
  const tenant = new StubRetriever([{ id: "ten", content: "y", score: 0 }]);
  setDefaultRetriever(def);
  registerRetriever("kb-a", tenant);
  registerRetriever("kb-a", null);
  try {
    const { documents } = await retrieve("q", { retrieverId: "kb-a" });
    assert.equal(documents[0]!.id, "def", "after deregister the default is used");
  } finally {
    setDefaultRetriever(null);
  }
});

// ─── retrieve: documents/texts, k, errors ──────────────────────────────────

test("retrieve rejects non-positive k", async () => {
  setDefaultRetriever(new StubRetriever());
  try {
    await assert.rejects(() => retrieve("q", { k: 0 }), /k must be positive/);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve defaults k to 5 and forwards the chosen k to the retriever", async () => {
  const five = new StubRetriever();
  setDefaultRetriever(five);
  try {
    await retrieve("q");
    assert.equal(five.calls[0]!.k, 5, "default k is 5");
  } finally {
    setDefaultRetriever(null);
  }
  const r = new StubRetriever([
    { id: "a", content: "1", score: 0 },
    { id: "b", content: "2", score: 0 },
    { id: "c", content: "3", score: 0 },
  ]);
  setDefaultRetriever(r);
  try {
    await retrieve("q", { k: 2 });
    assert.equal(r.calls[0]!.k, 2);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve populates documents and aligned texts", async () => {
  const docs: Document[] = [
    { id: "a", content: "alpha body", score: 0.9 },
    { id: "b", content: "beta body", score: 0.7 },
    { id: "c", content: "gamma body", score: 0.5 },
  ];
  setDefaultRetriever(new StubRetriever(docs));
  try {
    const { documents, texts } = await retrieve("anything", { k: 3 });
    assert.equal(documents.length, 3);
    assert.equal(texts.length, 3);
    documents.forEach((d, i) => assert.equal(texts[i], d.content, "texts parallel to documents"));
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve wraps and propagates a retriever error", async () => {
  const want = new Error("backend down");
  setDefaultRetriever(new StubRetriever([], want));
  try {
    await assert.rejects(
      () => retrieve("anything"),
      (err: Error) => {
        assert.match(err.message, /RetrieveOp: retrieve: backend down/);
        assert.equal((err as { cause?: unknown }).cause, want);
        return true;
      },
    );
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve round-trips document metadata unchanged", async () => {
  const docs: Document[] = [
    {
      id: "a",
      content: "alpha body",
      score: 0.9,
      metadata: {
        source_url: "https://example.com/a",
        highlights: ["alpha", "body"],
        updated_at: new Date(Date.UTC(2026, 3, 1, 12, 0, 0)),
        acl: ["public"],
      },
    },
    { id: "b", content: "beta body", score: 0.7 },
  ];
  setDefaultRetriever(new StubRetriever(docs));
  try {
    const { documents } = await retrieve("anything", { k: 2 });
    const md = documents[0]!.metadata!;
    assert.equal(md.source_url, "https://example.com/a");
    assert.deepEqual(md.highlights, ["alpha", "body"]);
    assert.ok(md.acl, "acl preserved");
    assert.equal(documents[1]!.metadata, undefined, "nil metadata stays absent");
  } finally {
    setDefaultRetriever(null);
  }
});

// ─── Filter convention (RetrievalFilters) ──────────────────────────────────

test("RetrievalFilters round-trips installed values", () => {
  const f = new RetrievalFilters({ tenant: "acme", category: "billing" });
  assert.equal(f.size, 2);
  assert.equal(f.get("tenant"), "acme");
  assert.deepEqual(f.values(), { tenant: "acme", category: "billing" });
});

test("RetrievalFilters.values() returns a defensive copy", () => {
  const f = new RetrievalFilters({ tenant: "acme", category: "billing" });
  const first = f.values();
  first.tenant = "globex";
  first.injected = "bad";
  delete first.category;
  const second = f.values();
  assert.equal(second.tenant, "acme", "mutation must not leak back");
  assert.equal(second.category, "billing");
  assert.equal(second.injected, undefined);
  assert.equal(Object.keys(second).length, 2);
});

// ─── retrieveWithFilters ───────────────────────────────────────────────────

test("retrieveWithFilters installs runtime filters into the retrieval ctx", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieveWithFilters("hello", { tenant: "acme", category: "billing" });
    assert.deepEqual(r.calls[0]!.filters, { tenant: "acme", category: "billing" });
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters: an empty/absent runtime map installs no filters and warns", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    const warnings = await captureWarn(async () => {
      await retrieveWithFilters("hello", {});
    });
    assert.equal(r.calls[0]!.filters, undefined, "retriever sees no filters");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /RetrieveWithFiltersOp has no filters/);

    // nil runtime map also warns.
    const warnings2 = await captureWarn(async () => {
      await retrieveWithFilters("hello", null);
    });
    assert.match(warnings2[0]!, /RetrieveWithFiltersOp has no filters/);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters does not warn when filters are present", async () => {
  setDefaultRetriever(new StubRetriever([{ id: "a", content: "alpha", score: 0 }]));
  try {
    const warnings = await captureWarn(async () => {
      await retrieveWithFilters("hello", { tenant: "acme" });
    });
    assert.equal(warnings.length, 0);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters populates documents and texts and respects retrieverId", async () => {
  const def = new StubRetriever([{ id: "def", content: "from default", score: 0 }]);
  const tenant = new StubRetriever([
    { id: "ten", content: "alpha body", score: 0.9 },
    { id: "ten2", content: "beta body", score: 0.7 },
  ]);
  setDefaultRetriever(def);
  registerRetriever("kb-a", tenant);
  try {
    const { documents, texts } = await retrieveWithFilters(
      "anything",
      { x: "y" },
      { retrieverId: "kb-a", k: 2 },
    );
    assert.equal(documents.length, 2);
    assert.equal(texts.length, 2);
    documents.forEach((d, i) => assert.equal(texts[i], d.content));
    assert.equal(documents[0]!.id, "ten");
    assert.equal(def.calls.length, 0);
  } finally {
    registerRetriever("kb-a", null);
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters fails fast without a retriever", async () => {
  setDefaultRetriever(null);
  await assert.rejects(() => retrieveWithFilters("q", { x: "y" }), /no default Retriever/);
});

// ─── Embedding credentials install ─────────────────────────────────────────

test("retrieve installs embedding credentials when configured", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieve("hello", {
      credentialRef: "vault://prod/voyage",
      clientFactoryId: "tenant-a",
      factoryTimeoutMs: 1500,
    });
    assert.deepEqual(r.calls[0]!.embeddingCredentials, {
      ref: "vault://prod/voyage",
      factoryId: "tenant-a",
      factoryTimeoutMs: 1500,
    });
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve applies the 30s default factory timeout when only credentialRef is set", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieve("hello", { credentialRef: "vault://x" });
    assert.equal(r.calls[0]!.embeddingCredentials!.factoryTimeoutMs, 30_000);
    assert.equal(r.calls[0]!.embeddingCredentials!.ref, "vault://x");
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve: explicit factoryTimeoutMs=0 still installs (disabled, distinct from unset)", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieve("hello", { factoryTimeoutMs: 0 });
    assert.equal(r.calls[0]!.embedCredsFound, true);
    assert.equal(r.calls[0]!.embeddingCredentials!.factoryTimeoutMs, 0);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve installs no credentials when none are configured", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieve("hello");
    assert.equal(r.calls[0]!.embedCredsFound, false);
    assert.equal(r.calls[0]!.embeddingCredentials, undefined);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters installs both filters and embedding credentials", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieveWithFilters(
      "hello",
      { tenant: "acme", category: "billing" },
      {
        credentialRef: "vault://prod/voyage",
        clientFactoryId: "tenant-a",
        factoryTimeoutMs: 2000,
      },
    );
    assert.deepEqual(r.calls[0]!.filters, { tenant: "acme", category: "billing" });
    assert.deepEqual(r.calls[0]!.embeddingCredentials, {
      ref: "vault://prod/voyage",
      factoryId: "tenant-a",
      factoryTimeoutMs: 2000,
    });
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters installs no credentials when unset (filters still install)", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieveWithFilters("hello", null, { staticFilters: { tenant: "acme" } });
    assert.equal(r.calls[0]!.embedCredsFound, false);
    assert.deepEqual(r.calls[0]!.filters, { tenant: "acme" });
  } finally {
    setDefaultRetriever(null);
  }
});

// ─── embed timeout ─────────────────────────────────────────────────────────

test("retrieve: embedTimeoutMs bounds the retrieve call (DeadlineExceeded)", async () => {
  setDefaultRetriever(new BlockingRetriever());
  try {
    const start = Date.now();
    await assert.rejects(
      () => retrieve("anything", { embedTimeoutMs: 20 }),
      (err: Error) => {
        assert.ok(isDeadlineExceeded(err), "error must carry a DeadlineExceededError cause");
        return true;
      },
    );
    assert.ok(Date.now() - start < 2000, "deadline should fire promptly");
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve: embedTimeoutMs=0 and unset impose no deadline", async () => {
  setDefaultRetriever(new StubRetriever([{ id: "a", content: "alpha", score: 0 }]));
  try {
    await retrieve("anything", { embedTimeoutMs: 0 });
    await retrieve("anything");
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve rejects a negative embedTimeoutMs", async () => {
  setDefaultRetriever(new StubRetriever());
  try {
    await assert.rejects(
      () => retrieve("q", { embedTimeoutMs: -1 }),
      /embedTimeoutMs must be non-negative/,
    );
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters: embedTimeoutMs bounds the retrieve call", async () => {
  setDefaultRetriever(new BlockingRetriever());
  try {
    await assert.rejects(
      () => retrieveWithFilters("anything", { tenant: "acme" }, { embedTimeoutMs: 20 }),
      (err: Error) => {
        assert.ok(isDeadlineExceeded(err));
        return true;
      },
    );
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieve is safe under concurrent calls", async () => {
  const r = new StubRetriever([{ id: "x", content: "x", score: 0 }]);
  setDefaultRetriever(r);
  try {
    const N = 20;
    await Promise.all(Array.from({ length: N }, () => retrieve("q")));
    assert.equal(r.calls.length, N);
  } finally {
    setDefaultRetriever(null);
  }
});

// ─── static filters ────────────────────────────────────────────────────────

test("retrieveWithFilters: static filters only, no runtime wire", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    const warnings = await captureWarn(async () => {
      await retrieveWithFilters("hello", null, {
        staticFilters: { tenant: "acme", locale: "en" },
      });
    });
    assert.deepEqual(r.calls[0]!.filters, { tenant: "acme", locale: "en" });
    assert.equal(warnings.length, 0);
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters: runtime overrides static on key collision", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieveWithFilters(
      "hello",
      { tenant: "globex", category: "billing" },
      { staticFilters: { tenant: "acme", locale: "en" } },
    );
    assert.deepEqual(r.calls[0]!.filters, {
      tenant: "globex",
      locale: "en",
      category: "billing",
    });
  } finally {
    setDefaultRetriever(null);
  }
});

test("retrieveWithFilters: static filters are isolated per call (no mutation leak)", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    const opts = { staticFilters: { tenant: "acme" } };
    await retrieveWithFilters("hello", null, opts);
    // Mutate the snapshot a retriever saw.
    r.calls[0]!.filters!.tenant = "mutated";
    r.calls[0]!.filters!.injected = "bad";
    await retrieveWithFilters("hello", null, opts);
    assert.equal(r.calls[1]!.filters!.tenant, "acme", "second call sees clean statics");
    assert.equal(r.calls[1]!.filters!.injected, undefined);
  } finally {
    setDefaultRetriever(null);
  }
});

// ─── parseStaticFilters (the CSV capability) ───────────────────────────────

test("parseStaticFilters parses and trims key=value pairs", () => {
  assert.deepEqual(parseStaticFilters("tenant=acme,locale=en"), {
    tenant: "acme",
    locale: "en",
  });
  assert.deepEqual(parseStaticFilters(" tenant = acme , locale = en "), {
    tenant: "acme",
    locale: "en",
  });
  assert.deepEqual(parseStaticFilters(""), {});
});

test("parseStaticFilters accepts an empty value (key=)", () => {
  assert.deepEqual(parseStaticFilters("tenant="), { tenant: "" });
});

test("parseStaticFilters rejects malformed input", () => {
  assert.throws(() => parseStaticFilters("tenant"), /expected key=value pair, got "tenant"/);
  assert.throws(() => parseStaticFilters("=value"), /empty key in pair "=value"/);
  assert.throws(() => parseStaticFilters("tenant=a,tenant=b"), /duplicate key "tenant"/);
});

test("parseStaticFilters output drives retrieveWithFilters staticFilters", async () => {
  const r = new StubRetriever([{ id: "a", content: "alpha", score: 0 }]);
  setDefaultRetriever(r);
  try {
    await retrieveWithFilters("hello", null, {
      staticFilters: parseStaticFilters("tenant=acme,locale=en"),
    });
    assert.deepEqual(r.calls[0]!.filters, { tenant: "acme", locale: "en" });
  } finally {
    setDefaultRetriever(null);
  }
});

// ─── validateCitations ─────────────────────────────────────────────────────

test("validateCitations: accept/reject split preserves first-appearance order", () => {
  const { accepted, rejected } = validateCitations(
    ["a", "x", "b", "y", "c"],
    ["a", "b", "c"],
  );
  assert.deepEqual(accepted, ["a", "b", "c"]);
  assert.deepEqual(rejected, ["x", "y"]);
});

test("validateCitations: empty allow-list rejects everything", () => {
  const { accepted, rejected } = validateCitations(["a", "b", "c"], []);
  assert.deepEqual(accepted, []);
  assert.deepEqual(rejected, ["a", "b", "c"]);
});

test("validateCitations: empty raw yields empty outputs", () => {
  const { accepted, rejected } = validateCitations([], ["a", "b"]);
  assert.deepEqual(accepted, []);
  assert.deepEqual(rejected, []);
});

test("validateCitations de-duplicates accepted and rejected", () => {
  assert.deepEqual(validateCitations(["a", "a", "a"], ["a"]).accepted, ["a"]);
  assert.deepEqual(validateCitations(["a", "a", "a"], ["a"]).rejected, []);
  assert.deepEqual(validateCitations(["x", "x", "x"], ["a"]).rejected, ["x"]);
});

test("validateCitations: null raw → empty; null allowed → all rejected", () => {
  assert.deepEqual(validateCitations(null, ["a"]), { accepted: [], rejected: [] });
  assert.deepEqual(validateCitations(["a", "b"], null), {
    accepted: [],
    rejected: ["a", "b"],
  });
});

test("MetadataSource constant is the expected key", () => {
  assert.equal(MetadataSource, "source");
});

// ─── Embedding factory registry + resolution ───────────────────────────────

test("resolveEmbeddingFactory: default, registered-wins, unknown-falls-back", () => {
  const def = new RecordingEmbeddingFactory();
  const tenant = new RecordingEmbeddingFactory();
  setDefaultEmbeddingClientFactory(def);
  registerEmbeddingClientFactory("tenant-a", tenant);
  try {
    assert.equal(resolveEmbeddingFactory(""), def);
    assert.equal(resolveEmbeddingFactory("tenant-a"), tenant);
    assert.equal(resolveEmbeddingFactory("nope"), def);
  } finally {
    registerEmbeddingClientFactory("tenant-a", null);
    setDefaultEmbeddingClientFactory(null);
  }
});

test("setDefaultEmbeddingClientFactory(null) resets to the bundled Env factory", () => {
  setDefaultEmbeddingClientFactory(new RecordingEmbeddingFactory());
  setDefaultEmbeddingClientFactory(null);
  assert.ok(resolveEmbeddingFactory("") instanceof EnvEmbeddingClientFactory);
});

test("registerEmbeddingClientFactory(id, null) deregisters", () => {
  const def = new RecordingEmbeddingFactory();
  const tenant = new RecordingEmbeddingFactory();
  setDefaultEmbeddingClientFactory(def);
  registerEmbeddingClientFactory("tenant-a", tenant);
  registerEmbeddingClientFactory("tenant-a", null);
  try {
    assert.equal(resolveEmbeddingFactory("tenant-a"), def);
  } finally {
    setDefaultEmbeddingClientFactory(null);
  }
});

test("resolveEmbeddingClient passes provider/model/ref to the factory", async () => {
  const def = new RecordingEmbeddingFactory();
  setDefaultEmbeddingClientFactory(def);
  try {
    await resolveEmbeddingClient(
      { ref: "vault://prod/voyage", factoryId: "", factoryTimeoutMs: 0 },
      "voyage",
      "voyage-3",
    );
    assert.deepEqual(def.calls, [
      { provider: "voyage", model: "voyage-3", ref: "vault://prod/voyage" },
    ]);
  } finally {
    setDefaultEmbeddingClientFactory(null);
  }
});

test("resolveEmbeddingClient: a registered factory wins over the default", async () => {
  const def = new RecordingEmbeddingFactory();
  const tenant = new RecordingEmbeddingFactory();
  setDefaultEmbeddingClientFactory(def);
  registerEmbeddingClientFactory("tenant-a", tenant);
  try {
    await resolveEmbeddingClient(
      { ref: "ref-x", factoryId: "tenant-a", factoryTimeoutMs: 0 },
      "openai",
      "text-embedding-3-small",
    );
    assert.equal(tenant.calls.length, 1);
    assert.equal(tenant.calls[0]!.ref, "ref-x");
    assert.equal(def.calls.length, 0);
  } finally {
    registerEmbeddingClientFactory("tenant-a", null);
    setDefaultEmbeddingClientFactory(null);
  }
});

test("resolveEmbeddingClient wraps a factory error", async () => {
  const want = new Error("vault denied");
  setDefaultEmbeddingClientFactory(new RecordingEmbeddingFactory(want));
  try {
    await assert.rejects(
      () => resolveEmbeddingClient(undefined, "openai", "text-embedding-3-small"),
      (err: Error) => {
        assert.match(err.message, /embedding client: vault denied/);
        assert.equal((err as { cause?: unknown }).cause, want);
        return true;
      },
    );
  } finally {
    setDefaultEmbeddingClientFactory(null);
  }
});

test("resolveEmbeddingClient: factoryTimeoutMs fires (DeadlineExceeded)", async () => {
  setDefaultEmbeddingClientFactory(new BlockingEmbeddingFactory());
  try {
    const start = Date.now();
    await assert.rejects(
      () =>
        resolveEmbeddingClient(
          { ref: "", factoryId: "", factoryTimeoutMs: 50 },
          "voyage",
          "voyage-3",
        ),
      (err: Error) => {
        assert.ok(isDeadlineExceeded(err));
        return true;
      },
    );
    assert.ok(Date.now() - start < 2000);
  } finally {
    setDefaultEmbeddingClientFactory(null);
  }
});

test("resolveEmbeddingClient: factoryTimeoutMs=0 disables the deadline", async () => {
  setDefaultEmbeddingClientFactory(new RecordingEmbeddingFactory());
  try {
    await resolveEmbeddingClient(
      { ref: "ref", factoryId: "", factoryTimeoutMs: 0 },
      "voyage",
      "voyage-3",
    );
  } finally {
    setDefaultEmbeddingClientFactory(null);
  }
});

test("EnvEmbeddingClientFactory rejects an unknown provider", () => {
  const f = new EnvEmbeddingClientFactory();
  assert.throws(
    () => f.embedder("openai", "text-embedding-3-small", ""),
    /registerEmbeddingClientFactory/,
  );
});

test("EnvEmbeddingClientFactory warns once per non-empty ref, silent on empty ref", async () => {
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-fake-key-not-used";
  try {
    const warnings = await captureWarn(() => {
      const f = new EnvEmbeddingClientFactory();
      f.embedder("gemini", "gemini-embedding-001", "tenant-a");
      f.embedder("gemini", "gemini-embedding-001", "tenant-a"); // cache hit, no re-warn
      f.embedder("gemini", "gemini-embedding-001", ""); // empty ref never warns
    });
    assert.equal(warnings.length, 1, "exactly one warning across the resolutions");
    assert.match(warnings[0]!, /ref="tenant-a" is ignored/);
    assert.match(warnings[0]!, /GEMINI_API_KEY/);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prev;
  }
});

// ─── GeminiEmbeddingClient chunking ────────────────────────────────────────

test("GeminiEmbeddingClient: a slice at the cap makes a single call", async () => {
  const fake = new FakeEmbedOnce();
  const c = new GeminiEmbeddingClient({ model: "gemini-embedding-001", embedOnce: fake.fn });
  const texts = Array.from({ length: GEMINI_EMBEDDING_MAX_BATCH }, () => "t");
  const out = await c.embed(texts);
  assert.equal(out.length, GEMINI_EMBEDDING_MAX_BATCH);
  assert.deepEqual(fake.callSizes, [GEMINI_EMBEDDING_MAX_BATCH]);
});

test("GeminiEmbeddingClient: over-cap input chunks and preserves order", async () => {
  const fake = new FakeEmbedOnce();
  const c = new GeminiEmbeddingClient({ model: "gemini-embedding-001", embedOnce: fake.fn });
  const n = 2 * GEMINI_EMBEDDING_MAX_BATCH + 17;
  const texts = Array.from({ length: n }, () => "t");
  const out = await c.embed(texts);
  assert.equal(out.length, n);
  assert.deepEqual(fake.callSizes, [
    GEMINI_EMBEDDING_MAX_BATCH,
    GEMINI_EMBEDDING_MAX_BATCH,
    17,
  ]);
  out.forEach((v, i) => {
    const expectedCall = Math.floor(i / GEMINI_EMBEDDING_MAX_BATCH) + 1;
    const expectedIdx = i % GEMINI_EMBEDDING_MAX_BATCH;
    assert.deepEqual(v, [expectedCall, expectedIdx], `out[${i}] order`);
  });
});

test("GeminiEmbeddingClient: an error in the second chunk surfaces and stops", async () => {
  const want = new Error("upstream boom");
  const fake = new FakeEmbedOnce(new Map([[2, want]]));
  const c = new GeminiEmbeddingClient({ model: "gemini-embedding-001", embedOnce: fake.fn });
  const texts = Array.from({ length: GEMINI_EMBEDDING_MAX_BATCH + 5 }, () => "t");
  await assert.rejects(
    () => c.embed(texts),
    (err: Error) => {
      assert.match(err.message, /gemini embedding: embed content: upstream boom/);
      assert.equal((err as { cause?: unknown }).cause, want);
      return true;
    },
  );
  assert.deepEqual(fake.callSizes, [GEMINI_EMBEDDING_MAX_BATCH, 5]);
});

test("GeminiEmbeddingClient: empty input skips the API", async () => {
  const fake = new FakeEmbedOnce();
  const c = new GeminiEmbeddingClient({ model: "gemini-embedding-001", embedOnce: fake.fn });
  const out = await c.embed([]);
  assert.deepEqual(out, []);
  assert.equal(fake.callSizes.length, 0);
});

test("GeminiEmbeddingClient: a response count mismatch errors", async () => {
  const short: EmbedOnce = async (texts) => ({
    embeddings: texts.slice(0, texts.length - 1).map(() => ({ values: [0] })),
  });
  const c = new GeminiEmbeddingClient({ model: "gemini-embedding-001", embedOnce: short });
  await assert.rejects(() => c.embed(["a", "b"]), /response count mismatch/);
});

test("DeadlineExceededError is detected through a cause chain", () => {
  const inner = new DeadlineExceededError();
  const wrapped = new Error("RetrieveOp: retrieve: x", { cause: inner });
  assert.ok(isDeadlineExceeded(wrapped));
  assert.ok(isDeadlineExceeded(inner));
  assert.equal(isDeadlineExceeded(new Error("plain")), false);
});
