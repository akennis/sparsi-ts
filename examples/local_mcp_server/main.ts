import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { Workflow, mcp } from "../../src";
import type { MCPScriptCallback } from "../../src/mcp";
import { runDualMode } from "../common";

const googleSearchBoxTarget = `textarea[name="q"]`;
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
const waitForSearchBoxJS = `async () => {
  for (let i = 0; i < 50; i++) {
    if (document.querySelector('textarea[name="q"], input[name="q"]')) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}`;
const waitForResultsJS = `async () => {
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('#search a[href], #rso a[href]')) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}`;
const extractURLsJS = `() => {
  const seen = new Set();
  const out = [];
  const root = document.querySelector('#search') || document.querySelector('#rso') || document.body;
  const isGoogleHost = (h) => h === 'google.com' || h.endsWith('.google.com') || h.endsWith('.googleusercontent.com') || h.endsWith('.gstatic.com');
  for (const a of root.querySelectorAll('a[href]')) {
    let h = a.href;
    if (!h) continue;
    if (h.startsWith('https://www.google.com/url?') || h.startsWith('http://www.google.com/url?')) {
      try { const u = new URL(h); const q = u.searchParams.get('q') || u.searchParams.get('url'); if (q) h = q; } catch (e) {}
    }
    if (!h.startsWith('http://') && !h.startsWith('https://')) continue;
    let host; try { host = new URL(h).hostname.toLowerCase(); } catch (e) { continue; }
    if (!host || isGoogleHost(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host); out.push(h);
    if (out.length >= 3) break;
  }
  return out;
}`;

interface ShotResult {
  url: string;
  path?: string;
  error?: string;
}

const PLAYWRIGHT_OPTS = {
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--timeout-action", "30000", "--timeout-navigation", "60000"],
  initTimeoutMs: 120000,
  callTimeoutMs: 90000,
  maxRetries: 1,
};

const googleSearchURLs: MCPScriptCallback<string, string[]> = async (sess, input) => {
  if (!input) throw new Error("empty query");
  await sess.callTool("browser_navigate", { url: "https://www.google.com/?hl=en" });
  try { await sess.callTool("browser_evaluate", { function: dismissConsentJS }); } catch {}
  await sess.callTool("browser_evaluate", { function: waitForSearchBoxJS });
  await sess.callTool("browser_type", { target: googleSearchBoxTarget, text: input, submit: true });
  try { await sess.callTool("browser_evaluate", { function: waitForResultsJS }); } catch {}
  const outcome = await sess.callTool("browser_evaluate", { function: extractURLsJS });
  
  // Decoding URLs from playwright-mcp response
  const decode = (v: any): string[] => {
      if (Array.isArray(v)) return v;
      if (v && v.result && Array.isArray(v.result)) return v.result;
      if (typeof v === "string") {
          try {
              const i = v.indexOf("### Result");
              const t = i >= 0 ? v.slice(i + 10) : v;
              return JSON.parse(t.trim());
          } catch {}
      }
      return [];
  };
  return decode(outcome.structured || outcome.text);
};

function build() {
  const wf = new Workflow();
  const query = wf.input<string>("query");
  const outDir = process.env.OUT_DIR || join(process.cwd(), ".playwright-mcp");

  const resultUrls = wf.mcp.script<string, string[]>(query, {
    ...PLAYWRIGHT_OPTS,
    script: googleSearchURLs,
    name: "find_results",
  });

  const screenshotOpts = { 
      ...PLAYWRIGHT_OPTS, 
      poolSize: 8, 
      script: (async (sess, url) => {
          const path = join(outDir, "shot-" + createHash("sha1").update(url || "").digest("hex").slice(0, 16) + ".png");
          try {
              await sess.callTool("browser_navigate", { url });
              await sess.callTool("browser_take_screenshot", { filename: path });
              return { url, path };
          } catch (err) {
              return { url, error: String(err) };
          }
      }) as MCPScriptCallback<string, ShotResult>
  };
  mcp.setupMCPScript(screenshotOpts);

  const shotResults = wf.map(resultUrls, (url, ctx) => mcp.mcpScript<string, ShotResult>(url, screenshotOpts, ctx), { name: "shoot_each" });

  const result = wf.op({ shotResults }, ({ shotResults }) => {
      return shotResults.map(r => {
          if (r.path) {
              try { return { ...r, bytes: statSync(r.path).size }; } catch {}
          }
          return r;
      });
  }, { name: "final_result" });

  return { wf, result };
}

if (require.main === module) {
  runDualMode(build, {
    name: "local_mcp_server",
    inputMapping: { query: "query" },
    outputNode: build().result
  }).catch(err => {
    console.error(err);
    process.exit(1);
  }).finally(() => mcp.shutdownMCPPool());
}
