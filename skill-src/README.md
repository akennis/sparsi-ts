# sparsi-ts Skills

Two skill packages for designing and generating sparsi-ts DAG workflows inside Claude Code
(or any AI assistant that supports the `SKILL.md / references/` convention).

**This bundle targets `sparsi-ts v0.1.0`.**
Download the matching bundle version from the [sparsi-ts releases page](https://github.com/akennis/sparsi-ts/releases)
when you upgrade to a new library version.

## Packages

| Package | Purpose |
|---|---|
| `sparsi-design` | Design a maximally deterministic DAG workflow from a task description |
| `sparsi-codegen` | Generate idiomatic, type-checking TypeScript from an approved DAG design |

## Typical workflow

1. `/sparsi-design` — describe your task; the skill produces a structured design document.
2. Refine the design until you approve it.
3. `/sparsi-codegen` — provide the approved design and an output directory; the skill writes a runnable
   TypeScript program, installs dependencies, runs `tsc` / the program, and fixes any errors automatically.
4. Run the program with `tsx`.

## Installation

These skills work with **Claude Code** — available as a CLI, desktop app, and IDE extension
(VS Code, JetBrains). They do not work with the Claude.ai chat app.

### Global install (available in every Claude Code session)

**macOS / Linux:**
```
cp -r sparsi-design  ~/.claude/skills/
cp -r sparsi-codegen ~/.claude/skills/
```

**Windows (PowerShell):**
```
Copy-Item -Recurse sparsi-design  "$env:USERPROFILE\.claude\skills\"
Copy-Item -Recurse sparsi-codegen "$env:USERPROFILE\.claude\skills\"
```

### Project-local install (available only in the current project)

```
cp -r sparsi-design  .claude/skills/
cp -r sparsi-codegen .claude/skills/
```

Then invoke with `/sparsi-design` or `/sparsi-codegen` from any Claude Code session.

## Updating

When a new bundle is released, download the new archive and replace the old directories:

**macOS / Linux:**
```
rm -rf ~/.claude/skills/sparsi-design ~/.claude/skills/sparsi-codegen
cp -r sparsi-design  ~/.claude/skills/
cp -r sparsi-codegen ~/.claude/skills/
```

**Windows (PowerShell):**
```
Remove-Item -Recurse "$env:USERPROFILE\.claude\skills\sparsi-design"
Remove-Item -Recurse "$env:USERPROFILE\.claude\skills\sparsi-codegen"
Copy-Item -Recurse sparsi-design  "$env:USERPROFILE\.claude\skills\"
Copy-Item -Recurse sparsi-codegen "$env:USERPROFILE\.claude\skills\"
```

No other steps are required — `library.md` is pre-generated in the bundle.

## Required environment variables

| Variable | When needed |
|---|---|
| `CLAUDE_API_KEY` | Any workflow that includes AI ops backed by Claude (the default provider) |
| `GEMINI_API_KEY` | Any workflow that includes AI ops or embeddings with the Gemini provider |

Neither variable is needed during design or code generation — only at runtime.
