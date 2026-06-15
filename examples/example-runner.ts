/**
 * sparsi-ts workflow — example smoke-runner.
 *
 * Discovers every *other* runnable example in this directory, runs each one as a
 * child `tsx` process, and confirms it exits 0. For any example that fails
 * (non-zero exit, crash, or timeout) it routes the captured stdout/stderr through
 * the `wf.ai.summarize` node constructor to produce a short root-cause diagnosis.
 *
 * The DAG has three nodes per example:
 *   run:<name>      — a `wf.source` op (no deps) that spawns `tsx <example>`,
 *                     capturing { ok, exitCode, stdout, stderr, timedOut }. It never
 *                     throws — a failing example is data, not an error.
 *   dump:<name>     — gated on `condition: !run.ok`; builds the failure dump fed to
 *                     the diagnosis. Skips for passing examples, so its skip
 *                     propagates to diagnose (a green run costs zero AI calls).
 *   diagnose:<name> — `wf.ai.summarize(dump, …)`: a first-class AI node (the engine
 *                     supplies ctx) returning a 1–2 sentence root cause.
 *                     `onError: "continue"` means an AI hiccup skips just that
 *                     diagnosis, never the whole run.
 *
 * Passing examples skip their dump+diagnose nodes entirely, so a green run costs
 * zero AI calls. Each example is an independent chain (run → dump → diagnose) with
 * no edges between examples, so the engine runs them in parallel up to
 * --concurrency. The final report is assembled in the driver from the resolved
 * nodes, reading the possibly-skipped diagnose node via result.getOr.
 *
 *                          discover()  →  [ N runnable examples ]
 *                                             fan-out (no cross-example edges)
 *      ┌───────────────────────────────┬───────────────────────────────┐
 *      │   ┌─────────────────────┐     │   ┌─────────────────────┐     │
 *      │   │ run:<example>       │     │   │ run:<example>       │     │  … ×N
 *      │   │ (wf.source, 0 deps) │     │   │ (wf.source, 0 deps) │     │
 *      │   │ spawn tsx <file>    │     │   │ spawn tsx <file>    │     │
 *      │   └──────────┬──────────┘     │   └──────────┬──────────┘     │
 *      │              ▼ run            │              ▼ run            │
 *      │   ┌─────────────────────┐     │   ┌─────────────────────┐     │
 *      │   │ dump:<example>      │     │   │ dump:<example>      │     │
 *      │   │ condition: !run.ok  │     │   │ condition: !run.ok  │     │
 *      │   └──────────┬──────────┘     │   └──────────┬──────────┘     │
 *      │              ▼ dump           │              ▼ dump           │
 *      │   ┌─────────────────────┐     │   ┌─────────────────────┐     │
 *      │   │ diagnose:<example>  │     │   │ diagnose:<example>  │     │
 *      │   │ wf.ai.summarize(…)  │     │   │ wf.ai.summarize(…)  │     │
 *      │   │ onError: "continue" │     │   │ onError: "continue" │     │
 *      │   └─────────────────────┘     │   └─────────────────────┘     │
 *      │   run.ok ⇒ SKIP (no AI)       │   run failed ⇒ AI diagnosis   │
 *      └───────────────────────────────┴───────────────────────────────┘
 *
 * AI is optional: with CLAUDE_API_KEY (or ANTHROPIC_API_KEY) set, failures get an
 * AI diagnosis; without it (or on an AI error) the diagnose node skips and the
 * driver falls back to a raw output tail via result.getOr.
 *
 * This file excludes itself from discovery, so it never tries to run itself.
 *
 * Options:
 *   --only <substr>      Run only examples whose name contains <substr>.   (all)
 *   --timeout <seconds>  Per-example wall-clock limit; on expiry the child  (90)
 *                        is SIGKILLed and recorded as a TIMEOUT failure.
 *   --concurrency <n>    Max examples running at once (also caps concurrent (4)
 *                        AI diagnoses).
 *
 *   npm run example:runner
 *   npm run example:runner -- --only temperature --timeout 60
 *   npm run example:runner -- --only mcp --concurrency 1
 */
import { readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { Workflow, ai } from "../src";
import type { RunContext, Node } from "../src";

const EXAMPLES_DIR = __dirname;
const ROOT = join(__dirname, "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

// This runner lives alongside the examples it runs; skip it during discovery so
// it never spawns itself.
const SELF = basename(__filename);

const MAX_CAPTURE = 256 * 1024; // cap each stream at 256 KiB

/** Outcome of running one example as a child process. */
interface Outcome {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

interface Example {
  name: string; // file basename without extension
  file: string; // absolute path
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Finds every runnable example: top-level `examples/*.ts` files that contain a
 * program entrypoint (a `.catch(` on a `main()` call). This excludes shared
 * helpers (e.g. rag-common.ts), this runner itself, and the lib/ and testdata/
 * subdirectories.
 */
function discover(): Example[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && e.name !== SELF)
    .map((e) => ({ name: e.name.replace(/\.ts$/, ""), file: join(EXAMPLES_DIR, e.name) }))
    .filter((ex) => /\.catch\(/.test(readFileSync(ex.file, "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Child-process runner ────────────────────────────────────────────────────

function tail(s: string, n = 4000): string {
  return s.length <= n ? s : "…(truncated)…\n" + s.slice(-n);
}

/** Spawns `tsx <file>` and resolves with its captured outcome. Never rejects. */
function runExample(ex: Example, signal: AbortSignal, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    // process.execPath is the node running this workflow (the nvm node), so the
    // child uses the same runtime; tsx's CLI transpiles the example on the fly.
    const child = spawn(process.execPath, [TSX_CLI, ex.file], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (buf: string, chunk: Buffer) =>
      buf.length >= MAX_CAPTURE ? buf : buf + chunk.toString("utf8");

    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, sig: NodeJS.Signals | null, errText?: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (errText) stderr = cap(stderr, Buffer.from(`\n[spawn error] ${errText}`));
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal: sig,
        timedOut,
        durationMs: Date.now() - started,
        stdout,
        stderr,
      });
    };

    child.on("error", (err) => finish(null, null, err.message));
    child.on("close", (code, sig) => finish(code, sig));
  });
}

// ─── Graph ───────────────────────────────────────────────────────────────────

interface DiagInput {
  run: Outcome;
}

const TRIAGE_PROMPT =
  "You are triaging a failed Node/TypeScript example program. In 1–2 sentences, " +
  "state the root cause of the failure. If it is a missing environment variable, " +
  "API key, or network/credential issue, name the specific variable or resource.";

/** One-line human reason an example failed (timeout / crash / non-zero exit). */
function reasonFor(o: Outcome, timeoutMs: number): string {
  return o.timedOut
    ? `timed out after ${timeoutMs} ms`
    : o.exitCode === null
      ? `did not start / was killed (signal ${o.signal ?? "?"})`
      : `exited with code ${o.exitCode}`;
}

/** The full failure dump fed to the AI diagnosis op. */
function buildDump(ex: Example, o: Outcome, timeoutMs: number): string {
  return (
    `Example "${ex.name}" ${reasonFor(o, timeoutMs)}.\n` +
    `--- STDERR (tail) ---\n${tail(o.stderr) || "(empty)"}\n` +
    `--- STDOUT (tail) ---\n${tail(o.stdout) || "(empty)"}`
  );
}

/**
 * Driver-side fallback when the AI diagnosis is unavailable — no AI client, or
 * the diagnose node skipped on an AI error. Gives the raw output tail rather than
 * an empty diagnosis.
 */
function rawTailFallback(o: Outcome, timeoutMs: number): string {
  return `${reasonFor(o, timeoutMs)}. (no AI diagnosis; raw tail)\n${tail(o.stderr || o.stdout, 600)}`;
}

function build(examples: Example[], timeoutMs: number) {
  const wf = new Workflow();
  const nodes: { ex: Example; run: Node<Outcome>; diagnose: Node<string> }[] = [];

  for (const ex of examples) {
    // Source op (no deps): run the example.
    const run = wf.source(
      (ctx: RunContext) => runExample(ex, ctx.signal, timeoutMs),
      { name: `run:${ex.name}` },
    );

    // Failure lane. The dump node builds the diagnosis input only for examples
    // that didn't exit 0 (condition: !run.ok); its skip propagates to the AI node,
    // so a green run costs zero AI calls.
    const dump = wf.op(
      { run },
      ({ run }: DiagInput): string[] => [buildDump(ex, run, timeoutMs)],
      { name: `dump:${ex.name}`, condition: ({ run }: DiagInput) => !run.ok },
    );

    // AI root-cause as a first-class node. onError "continue" skips just this
    // diagnosis on an AI hiccup; the driver then falls back to a raw tail via getOr.
    const diagnose = wf.ai.summarize(dump, {
      operation: TRIAGE_PROMPT,
      name: `diagnose:${ex.name}`,
      onError: "continue",
    });

    nodes.push({ ex, run, diagnose });
  }

  return { wf, nodes };
}

// ─── Driver ──────────────────────────────────────────────────────────────────

interface Args {
  timeoutMs: number;
  concurrency: number;
  only?: string;
}

function parseRunnerArgs(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      timeout: { type: "string" },
      concurrency: { type: "string" },
      only: { type: "string" },
    },
  });
  return {
    timeoutMs: values.timeout ? Number(values.timeout) * 1000 : 90_000,
    concurrency: values.concurrency ? Number(values.concurrency) : 4,
    only: values.only,
  };
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

async function main() {
  const args = parseRunnerArgs(process.argv.slice(2));

  let examples = discover();
  if (args.only) examples = examples.filter((e) => e.name.includes(args.only!));
  if (examples.length === 0) {
    console.error(`no examples found in ${EXAMPLES_DIR}${args.only ? ` matching "${args.only}"` : ""}`);
    process.exit(2);
  }

  const hasKey = !!(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY);
  console.error(
    `Running ${examples.length} example(s) from ${EXAMPLES_DIR}\n` +
      `  concurrency=${args.concurrency}  timeout=${args.timeoutMs / 1000}s  ` +
      `AI diagnosis=${hasKey ? "on (Claude)" : "off (no CLAUDE_API_KEY — raw tails)"}\n`,
  );

  const { wf, nodes } = build(examples, args.timeoutMs);
  const result = await wf.run({
    ai: hasKey ? new ai.AnthropicClient() : undefined,
    concurrency: args.concurrency,
  });

  // Assemble the report from resolved nodes. diagnose is SKIP for passing
  // examples, so read it defensively with getOr.
  let passed = 0;
  let failed = 0;
  const lines: string[] = [];
  for (const { ex, run, diagnose } of nodes) {
    const o = result.get(run);
    const dur = `${(o.durationMs / 1000).toFixed(1)}s`;
    if (o.ok) {
      passed++;
      lines.push(`${GREEN}✔ PASS${RESET}  ${ex.name}  ${DIM}(${dur})${RESET}`);
    } else {
      failed++;
      // diagnose SKIPs without an AI client or on an AI error; fall back to a raw tail.
      const why = result.getOr(diagnose, rawTailFallback(o, args.timeoutMs));
      const status = o.timedOut ? "TIMEOUT" : o.exitCode === null ? "CRASH" : `exit ${o.exitCode}`;
      lines.push(`${RED}✗ FAIL${RESET}  ${ex.name}  ${DIM}(${status}, ${dur})${RESET}\n        ↳ ${why}`);
    }
  }

  console.log("\n─── Example run report ───────────────────────────────────────────");
  console.log(lines.join("\n"));
  console.log("──────────────────────────────────────────────────────────────────");
  console.log(`${passed} passed, ${failed} failed, ${examples.length} total`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("runner:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(2);
});
