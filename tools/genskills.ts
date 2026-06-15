/**
 * genskills assembles the skills/ distribution directory from canonical sources.
 * It is the TypeScript analogue of sparsi-go's tools/genskills + tools/genlibdesc
 * (folded into one generator, since `ops.allDescriptions()` already aggregates the
 * AI / Retrieval / MCP groups alongside the deterministic ops).
 *
 *   skill-src/README.md                                   -> skills/README.md                                   (verbatim)
 *   skill-src/<skill>/SKILL.md                            -> skills/<skill>/SKILL.md                            (verbatim)
 *   skill-src/<skill>/references/examples/README.md       -> skills/<skill>/references/examples/README.md       (verbatim)
 *   skill-src/sparsi-design/references/design-rules.md    -> skills/sparsi-design/references/design-rules.md     (verbatim)
 *   skill-src/sparsi-codegen/references/sparsi-api.md     -> skills/sparsi-codegen/references/sparsi-api.md      (verbatim)
 *   ops.allDescriptions()                                 -> skills/<skill>/references/library.md               (generated)
 *   examples/<file>.ts                                    -> skills/<skill>/references/examples/<name>/main.ts  (+ siblings, verbatim)
 *
 * Run via: npm run build:skills
 * Or directly: npx tsx tools/genskills.ts
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ops } from "../src";

const REPO = join(__dirname, "..");
const SKILL_SRC = join(REPO, "skill-src");
const SKILLS = join(REPO, "skills");
const EXAMPLES = join(REPO, "examples");

const SKILL_NAMES = ["sparsi-design", "sparsi-codegen"] as const;

/**
 * Each example becomes a directory under references/examples/. The first file is
 * copied to `<name>/main.ts` (mirroring sparsi-go's `<name>/main.go`); any sibling
 * files keep their own name so the example's relative imports still resolve. The
 * set and ordering mirror sparsi-go's exampleDirs so the two bundles stay aligned.
 */
const EXAMPLE_DIRS: Record<string, string[]> = {
  "ticket-triager": ["ticket-triager.ts"],
  "recipe-analyzer": ["recipe-analyzer.ts"],
  "readme-quality": ["readme-quality.ts"],
  "stock-analyzer": ["stock-analyzer.ts"],
  "weather-advisor": ["weather-advisor.ts"],
  "hn-topic-brief": ["hn-topic-brief.ts"],
  "faithful-summary": ["faithful-summary.ts"],
  "local-mcp-server": ["local-mcp-server.ts"],
  "remote-mcp-server": ["remote-mcp-server.ts"],
  "with-repair": ["with-repair.ts"],
  "rag-bm25": ["rag-bm25.ts", "rag-common.ts"],
  "rag-gemini-embed": ["rag-gemini-embed.ts", "rag-common.ts"],
};

function write(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`wrote ${path}`);
}

function copy(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`wrote ${dst}`);
}

function main(): void {
  copy(join(SKILL_SRC, "README.md"), join(SKILLS, "README.md"));

  const libContent = "# Available Library Ops\n\n" + ops.allDescriptions() + "\n";

  for (const skill of SKILL_NAMES) {
    copy(
      join(SKILL_SRC, skill, "SKILL.md"),
      join(SKILLS, skill, "SKILL.md"),
    );
    copy(
      join(SKILL_SRC, skill, "references", "examples", "README.md"),
      join(SKILLS, skill, "references", "examples", "README.md"),
    );
    write(join(SKILLS, skill, "references", "library.md"), libContent);
  }

  copy(
    join(SKILL_SRC, "sparsi-design", "references", "design-rules.md"),
    join(SKILLS, "sparsi-design", "references", "design-rules.md"),
  );
  copy(
    join(SKILL_SRC, "sparsi-codegen", "references", "sparsi-api.md"),
    join(SKILLS, "sparsi-codegen", "references", "sparsi-api.md"),
  );

  for (const [name, files] of Object.entries(EXAMPLE_DIRS)) {
    files.forEach((file, i) => {
      // The primary file (index 0) is renamed to main.ts; siblings keep their name.
      const destName = i === 0 ? "main.ts" : file;
      for (const skill of SKILL_NAMES) {
        copy(
          join(EXAMPLES, file),
          join(SKILLS, skill, "references", "examples", name, destName),
        );
      }
    });
  }
}

main();
