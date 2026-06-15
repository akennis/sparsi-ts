import { test } from "node:test";
import assert from "node:assert/strict";
import type { AICallRequest, AIClient } from "../src";
import { GeminiClient, MockAIClient } from "../src/ai/client";
import type { GeminiClientOptions } from "../src/ai/client";
import {
  EnvAIClientFactory,
  newAIClient,
  registerAIClientFactory,
  resolveAIClientFactory,
  setDefaultAIClientFactory,
} from "../src/ai/factory";
import type { AIClientFactory, AIProvider } from "../src/ai/factory";

/** Records every resolution and hands back a fixed client. */
class StubFactory implements AIClientFactory {
  readonly calls: { provider: AIProvider; ref: string }[] = [];
  constructor(private readonly client: AIClient) {}
  forProvider(provider: AIProvider, ref = ""): AIClient {
    this.calls.push({ provider, ref });
    return this.client;
  }
}

test("newAIClient resolves the claude provider via an injected factory", async () => {
  const factory = new StubFactory(new MockAIClient(["hello"]));
  const client = newAIClient({ factory, retry: { maxRetries: 0 } });
  const res = await client.call({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.text, "hello");
  assert.deepEqual(factory.calls, [{ provider: "claude", ref: "" }]);
});

test("newAIClient rejects unsupported providers", () => {
  const bad: string = "openai";
  assert.throws(
    () => newAIClient({ provider: bad as AIProvider }),
    /unsupported provider "openai": must be "claude" or "gemini"/,
  );
});

test("newAIClient passes ref to the factory and applies the model override", async () => {
  const factory = new StubFactory(new MockAIClient((req) => req.model ?? "(no model)"));
  const client = newAIClient({
    provider: "gemini",
    ref: "prod",
    model: "gemini-2.5-pro",
    factory,
    retry: { maxRetries: 0 },
  });
  const res = await client.call({ messages: [{ role: "user", content: "x" }] });
  assert.equal(res.text, "gemini-2.5-pro", "model is defaulted onto requests that omit it");
  assert.deepEqual(factory.calls, [{ provider: "gemini", ref: "prod" }]);
});

test("newAIClient wraps the provider client with transient-error retry", async () => {
  let calls = 0;
  const flaky: AIClient = {
    defaultModel: "claude-sonnet-4-6",
    call: async () => {
      calls++;
      if (calls === 1) throw new Error("503 service unavailable");
      return { text: "recovered" };
    },
  };
  const client = newAIClient({
    factory: new StubFactory(flaky),
    retry: { maxRetries: 2, initialDelayMs: 1 },
  });
  const res = await client.call({ messages: [{ role: "user", content: "x" }] });
  assert.equal(res.text, "recovered");
  assert.equal(calls, 2, "the transient 503 is retried once");
});

test("EnvAIClientFactory caches per ref and warns once per non-empty ref", () => {
  const prevClaude = process.env.CLAUDE_API_KEY;
  const prevGemini = process.env.GEMINI_API_KEY;
  process.env.CLAUDE_API_KEY = "test-key";
  process.env.GEMINI_API_KEY = "test-key";
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warnings.push(String(msg));
  };
  try {
    const f = new EnvAIClientFactory();

    const a1 = f.forProvider("claude", "");
    const a2 = f.forProvider("claude", "");
    assert.equal(a1, a2, "same ref returns the cached client");
    assert.equal(warnings.length, 0, "the empty ref never warns");

    const b1 = f.forProvider("claude", "tenant-acme");
    const b2 = f.forProvider("claude", "tenant-acme");
    assert.equal(b1, b2);
    assert.equal(warnings.length, 1, "warns exactly once per non-empty ref");
    assert.match(warnings[0]!, /ref="tenant-acme" is ignored/);
    assert.match(warnings[0]!, /CLAUDE_API_KEY/);

    // Different provider, same ref string => independent cache + its own warning.
    f.forProvider("gemini", "tenant-acme");
    assert.equal(warnings.length, 2);
    assert.match(warnings[1]!, /GEMINI_API_KEY/);
  } finally {
    console.warn = origWarn;
    restoreEnv("CLAUDE_API_KEY", prevClaude);
    restoreEnv("GEMINI_API_KEY", prevGemini);
  }
});

test("factory registry resolves by id and falls back to the default", () => {
  setDefaultAIClientFactory(null); // baseline: bundled EnvAIClientFactory
  const custom = new StubFactory(new MockAIClient([]));
  registerAIClientFactory("custom", custom);
  try {
    assert.equal(resolveAIClientFactory("custom"), custom);
    assert.ok(
      resolveAIClientFactory("unknown") instanceof EnvAIClientFactory,
      "unknown id falls back to the default",
    );
    assert.ok(resolveAIClientFactory("") instanceof EnvAIClientFactory);
  } finally {
    registerAIClientFactory("custom", null);
  }
});

test("setDefaultAIClientFactory swaps the default used by newAIClient", async () => {
  const custom = new StubFactory(new MockAIClient(["from-default"]));
  setDefaultAIClientFactory(custom);
  try {
    const client = newAIClient({ retry: { maxRetries: 0 } });
    const res = await client.call({ messages: [{ role: "user", content: "x" }] });
    assert.equal(res.text, "from-default");
    assert.deepEqual(custom.calls, [{ provider: "claude", ref: "" }]);
  } finally {
    setDefaultAIClientFactory(null);
    assert.ok(resolveAIClientFactory("") instanceof EnvAIClientFactory, "null resets to bundled");
  }
});

test("GeminiClient maps the shared request onto generateContent", async () => {
  const captured: Array<{
    model: string;
    contents: unknown;
    config: Record<string, unknown>;
  }> = [];
  const stubSdk = {
    models: {
      generateContent: async (params: {
        model: string;
        contents: unknown;
        config: Record<string, unknown>;
      }) => {
        captured.push(params);
        return { text: "gemini-says-hi", candidates: [{ finishReason: "STOP" }] };
      },
    },
  };
  const client = new GeminiClient({
    sdk: stubSdk as unknown as NonNullable<GeminiClientOptions["sdk"]>,
    model: "gemini-2.5-flash",
  });

  const req: AICallRequest = {
    system: "be terse",
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ],
    maxTokens: 256,
  };
  const res = await client.call(req);

  assert.equal(res.text, "gemini-says-hi");
  const p = captured[0]!;
  assert.equal(p.model, "gemini-2.5-flash");
  assert.equal(p.config.systemInstruction, "be terse");
  assert.equal(p.config.maxOutputTokens, 256);
  assert.deepEqual(p.contents, [
    { role: "user", parts: [{ text: "u1" }] },
    { role: "model", parts: [{ text: "a1" }] },
    { role: "user", parts: [{ text: "u2" }] },
  ]);
});

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}
