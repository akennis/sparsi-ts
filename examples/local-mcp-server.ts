/**
 * MCP example — a local (stdio) playwright-mcp Google-search-and-screenshot DAG.
 *
 * Two MCPScriptOp variants are composed via a map fan-out:
 *
 *   query ─► find_results ─► shoot_each (map) ─► screenshot_results
 *           (one playwright-mcp   (per-URL playwright-mcp
 *            session, emits         subprocess, N parallel;
 *            first 3 URLs)          emits ShotResult each)
 *
 * `find_results` drives ONE long-lived browser session: navigate to Google,
 * best-effort dismiss the EU/UK consent dialog, type the query, wait for the
 * results container, then evaluate JS that returns the first 3 distinct
 * off-Google result URLs. `shoot_each` maps over those URLs, each opening a
 * fresh pooled playwright-mcp subprocess (pool_size=8) to navigate and save a
 * screenshot to `<out_dir>/shot-<sha1(url)[:16]>.png`.
 *
 * Per-URL screenshots run best-effort: a navigation or screenshot failure for
 * one URL is captured on that URL's ShotResult and reported alongside the
 * successes — it never aborts the DAG.
 *
 * A clean CLI entry point: the search query is the workflow input; the screenshot
 * output directory is operational config resolved in main().
 *
 * Prerequisites:
 *   - npx on PATH (Node.js). The first run downloads @playwright/mcp@latest; later
 *     runs reuse the cache.
 *   - Playwright's Chromium browser: `npx playwright install chromium` (the opts
 *     below pass `--browser chromium`, so no system Google Chrome is needed).
 *   - No CLAUDE_API_KEY required.
 *     npm run example:local-mcp
 *     npm run example:local-mcp -- --query "Shizuoka" --out-dir C:\shots
 */
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { Workflow, mcp } from "../src";
import type { MCPScriptCallback } from "../src/mcp";

// ─── Search step ─────────────────────────────────────────────────────────────

const googleSearchBoxTarget = `textarea[name="q"]`;

/**
 * Best-effort clicks Google's "Accept all" / "I agree" consent button when the
 * EU/UK consent.google.com interstitial fires (or an in-page modal is present).
 * Returns the matched label, or "" if none.
 */
const dismissConsentJS = `() => {
  const labels = ['accept all','i agree','agree','aceptar todo','akzeptieren','tout accepter','accetta tutto','aceitar tudo','accept'];
  const norm = (s) => (s || '').trim().toLowerCase();
  const match = (s) => { const t = norm(s); return labels.some(l => t === l || t.startsWith(l + ' ')); };
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
  for (const b of candidates) {
    const txt = b.innerText || b.textContent || b.value || '';
    const aria = (b.getAttribute && b.getAttribute('aria-label')) || '';
    if (match(txt))  { b.click(); return norm(txt).slice(0, 40); }
    if (match(aria)) { b.click(); return norm(aria).slice(0, 40); }
  }
  return '';
}`;

/**
 * Polls up to ~10s for Google's search box. The consent click above can trigger
 * a redirect back to google.com, so we don't assume the box is already mounted.
 */
const waitForSearchBoxJS = `async () => {
  for (let i = 0; i < 50; i++) {
    if (document.querySelector('textarea[name="q"], input[name="q"]')) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}`;

/**
 * Polls up to ~12s for at least one anchor inside Google's results container. A
 * much stronger signal than matching the query string against page text — the
 * query is already in the search box well before results actually render.
 */
const waitForResultsJS = `async () => {
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('#search a[href], #rso a[href]')) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}`;

/**
 * Picks the first 3 distinct off-Google http(s) hrefs from the search results
 * container, deduped by hostname so we don't return three links to the same
 * site. Scoped to #search/#rso so header/footer/nav links can't slip in.
 * Unwraps Google's /url?q= redirect wrapper. Excludes any *.google.tld,
 * googleusercontent, and gstatic host.
 */
const extractURLsJS = `() => {
  const seen = new Set();
  const out = [];
  const root = document.querySelector('#search') || document.querySelector('#rso') || document.body;
  const isGoogleHost = (h) => h === 'google.com' ||
    h.endsWith('.google.com') ||
    h.endsWith('.googleusercontent.com') ||
    h.endsWith('.gstatic.com') ||
    /\\.google\\.[a-z.]+$/.test(h);
  for (const a of root.querySelectorAll('a[href]')) {
    let h = a.href;
    if (!h) continue;
    if (h.startsWith('https://www.google.com/url?') || h.startsWith('http://www.google.com/url?')) {
      try {
        const u = new URL(h);
        const q = u.searchParams.get('q') || u.searchParams.get('url');
        if (q) h = q;
      } catch (e) {}
    }
    if (!h.startsWith('http://') && !h.startsWith('https://')) continue;
    let host;
    try { host = new URL(h).hostname.toLowerCase(); } catch (e) { continue; }
    if (!host || isGoogleHost(host)) continue;
    if (seen.has(host)) continue;
    if (a.closest('header, footer, nav')) continue;
    seen.add(host);
    out.push(h);
    if (out.length >= 3) break;
  }
  return out;
}`;

// ─── Per-URL screenshot step: typed output ──────────────────────────────────

/**
 * Travels with each map sub-output so URL, screenshot path, and any per-URL
 * error stay paired by structure rather than by positional zip. Exactly one of
 * `path` or `error` is meaningful.
 */
interface ShotResult {
  url: string;
  path?: string;
  error?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function screenshotName(url: string): string {
  const h = createHash("sha1").update(url).digest("hex");
  return "shot-" + h.slice(0, 16) + ".png";
}

/**
 * Pulls a string out of a browser_evaluate structured payload that may be a bare
 * string, a `{ result: "foo" }` wrapper, or empty/false/null. Returns "" for
 * falsy/missing values.
 */
function normalizeJSStringResult(structured: unknown): string {
  if (structured === null || typeof structured !== "object") return "";
  const r = (structured as { result?: unknown }).result;
  if (typeof r === "string") return r.trim();
  return "";
}

/** Decodes a value into `string[]` if it is a non-empty string array or `{result: string[]}`. */
function decodeURLs(value: unknown): string[] | null {
  const asStrArray = (v: unknown): string[] | null =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")
      ? (v as string[])
      : null;
  const direct = asStrArray(value);
  if (direct) return direct;
  if (value && typeof value === "object") {
    const wrapped = asStrArray((value as { result?: unknown }).result);
    if (wrapped) return wrapped;
  }
  return null;
}

/**
 * Returns the `string[]` carried by a browser_evaluate result, or null. The
 * already-decoded structured payload is the primary route; the text fallback only
 * fires when structured content is absent. playwright-mcp frames the text payload
 * with a "### Result" header before the JSON, so we strip that and parse what
 * remains.
 */
function parseURLList(structured: unknown, text: string): string[] | null {
  if (structured !== undefined) {
    const arr = decodeURLs(structured);
    if (arr) return arr;
  }
  let t = text;
  const i = t.indexOf("### Result");
  if (i >= 0) t = t.slice(i + "### Result".length);
  try {
    return decodeURLs(JSON.parse(t.trim()));
  } catch {
    return null;
  }
}

// ─── MCP scripts ────────────────────────────────────────────────────────────

/** stdio playwright-mcp connection options shared by both steps. */
const PLAYWRIGHT_OPTS = {
  command: "npx",
  // `--browser chromium` uses Playwright's bundled Chromium (installed via
  // `npx playwright install chromium`) instead of playwright-mcp's default
  // "chrome" channel, which requires a system Google Chrome install.
  //
  // playwright-mcp's internal action / navigation guards default to 5000ms /
  // 30000ms. Heavy fonts or slow CDNs blow past the 5 s action guard during
  // browser_take_screenshot, so we widen both via the playwright-mcp CLI flags.
  args: ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--timeout-action", "30000", "--timeout-navigation", "60000"],
  initTimeoutMs: 120000,
  callTimeoutMs: 90000,
  maxRetries: 1,
};

/** Google → search → extract first 3 URLs over one playwright-mcp session. */
const googleSearchURLs: MCPScriptCallback<string, string[]> = async (sess, input) => {
  if (!input || input === "") {
    throw new Error("googleSearchURLs: empty query");
  }
  try {
    await sess.callTool("browser_navigate", { url: "https://www.google.com/?hl=en" });
  } catch (err) {
    throw new Error(`browser_navigate: ${errMsg(err)}`);
  }

  // Best-effort consent dismissal. Failures are non-fatal — the follow-up
  // wait-for-search-box will surface a real problem.
  try {
    const { structured } = await sess.callTool("browser_evaluate", { function: dismissConsentJS });
    const label = normalizeJSStringResult(structured);
    if (label !== "") console.error(`dismissed Google consent dialog: ${label}`);
  } catch {
    // ignore
  }

  // Wait for the search box before typing — the consent click can trigger a
  // redirect that takes a moment to settle.
  try {
    await sess.callTool("browser_evaluate", { function: waitForSearchBoxJS });
  } catch (err) {
    throw new Error(`wait for search box: ${errMsg(err)}`);
  }

  try {
    await sess.callTool("browser_type", {
      target: googleSearchBoxTarget,
      text: input,
      submit: true,
    });
  } catch (err) {
    throw new Error(`browser_type: ${errMsg(err)}`);
  }

  // Wait for the results container, not for query echo on the page.
  try {
    await sess.callTool("browser_evaluate", { function: waitForResultsJS });
  } catch (err) {
    console.error(`wait for results soft-failed: ${errMsg(err)}`);
  }

  let outcome;
  try {
    outcome = await sess.callTool("browser_evaluate", { function: extractURLsJS });
  } catch (err) {
    throw new Error(`browser_evaluate: ${errMsg(err)}`);
  }

  const urls = parseURLList(outcome.structured, outcome.text);
  if (urls === null) {
    throw new Error(
      `parse URL list (text=${JSON.stringify(truncate(outcome.text, 200))}): could not decode URL list from structured or text payload`,
    );
  }
  if (urls.length === 0) {
    throw new Error(`browser_evaluate returned no URLs (text=${JSON.stringify(truncate(outcome.text, 200))})`);
  }
  return urls;
};

/**
 * Navigates a fresh playwright-mcp session to a single URL and saves a
 * screenshot to `<outDir>/shot-<sha1(url)[:16]>.png`. Best-effort: navigation or
 * screenshot failures are captured on ShotResult.error and reported, never
 * aborting the DAG.
 */
function makeScreenshotScript(outDir: string): MCPScriptCallback<string, ShotResult> {
  return async (sess, input) => {
    if (!input || input === "") return { url: "", error: "empty url" };
    const out: ShotResult = { url: input };
    const path = join(outDir, screenshotName(input));
    try {
      await sess.callTool("browser_navigate", { url: input });
    } catch (err) {
      out.error = `browser_navigate: ${errMsg(err)}`;
      return out;
    }
    try {
      await sess.callTool("browser_take_screenshot", { filename: path });
    } catch (err) {
      out.error = `browser_take_screenshot: ${errMsg(err)}`;
      return out;
    }
    out.path = path;
    return out;
  };
}

// ─── Graph ──────────────────────────────────────────────────────────────────

function build(outDir: string) {
  const wf = new Workflow();
  const query = wf.input<string>("query");

  // Stage 1 — Google → first 3 URLs over one playwright-mcp session. The node
  // constructor takes the query node directly, supplies `ctx`, and runs setup
  // (validate + prewarm) at build time.
  const resultUrls = wf.mcp.script<string, string[]>(query, {
    ...PLAYWRIGHT_OPTS,
    script: googleSearchURLs,
    name: "find_results",
  });

  // Stage 2 — per-URL screenshot fan-out (one pooled subprocess each). This is a
  // map fan-out (mcpScript per URL), which the single-node-in/single-node-out
  // `wf.mcp.script` constructor can't express — so it calls the free `mcpScript`.
  // We run setup here ourselves so the stdio pool still prewarms, matching the
  // guarantee the constructor gives stage 1.
  const screenshotOpts = { ...PLAYWRIGHT_OPTS, poolSize: 8, script: makeScreenshotScript(outDir) };
  mcp.setupMCPScript(screenshotOpts);
  const shotResults = wf.map(
    resultUrls,
    (url, ctx) => mcp.mcpScript<string, ShotResult>(url, screenshotOpts, ctx),
    { name: "shoot_each" },
  );

  return { wf, resultUrls, shotResults };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

/** Applies the default (<cwd>/.playwright-mcp), enforces an absolute path, creates it. */
function resolveOutDir(flagVal: string | undefined): string {
  let outDir = flagVal ?? "";
  if (outDir === "") {
    outDir = join(process.cwd(), ".playwright-mcp");
  } else if (!isAbsolute(outDir)) {
    throw new Error("--out-dir must be absolute");
  }
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

interface ShotInfo {
  url: string;
  path: string;
  bytes: number;
}

interface ShotErr {
  url: string;
  error: string;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { query: { type: "string" }, "out-dir": { type: "string" } },
  });
  const query = values.query ?? "Shizuoka";
  const outDir = resolveOutDir(values["out-dir"]);

  const { wf, shotResults } = build(outDir);
  let results: ShotResult[];
  try {
    const result = await wf.run({
      values: { query },
      concurrency: 8,
    });
    results = result.get(shotResults);
  } finally {
    // Drain pooled playwright-mcp subprocesses started for the shoot fan-out.
    await mcp.shutdownMCPPool();
  }

  const screenshots: ShotInfo[] = [];
  const errors: ShotErr[] = [];
  for (const r of results) {
    if (r.error && r.error !== "") {
      errors.push({ url: r.url, error: r.error });
      continue;
    }
    const path = r.path ?? "";
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      // leave bytes at 0 if the file isn't readable
    }
    screenshots.push({ url: r.url, path, bytes });
  }

  // Human-readable summary on stderr; machine-readable JSON on stdout.
  process.stderr.write(`captured ${screenshots.length} screenshot(s), ${errors.length} failure(s)\n`);
  for (const s of screenshots) {
    process.stderr.write(`  ok  ${s.url} -> ${s.path} (${s.bytes} bytes)\n`);
  }
  for (const e of errors) {
    process.stderr.write(`  err ${e.url} : ${e.error}\n`);
  }

  const out = {
    query,
    out_dir: outDir,
    screenshots,
    ...(errors.length > 0 ? { errors } : {}),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error("workflow:", err instanceof Error ? err.message : err);
  process.exit(1);
});
