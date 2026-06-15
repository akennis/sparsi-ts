# Installs the sparsi-ts skill bundle into the user's Claude Code skills dir.
#
# For each skill in $SkillNames:
#   1. If $HOME/.claude/skills/<skill> exists, it is deleted (recursively).
#   2. The freshly-built skills/<skill> from this repo is copied in its place.
#
# The skills/ directory is a build artifact — run `npm run build:skills` first if
# it is missing or stale.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SkillNames = @('sparsi-design', 'sparsi-codegen')

$RepoRoot   = $PSScriptRoot
$SourceRoot = Join-Path $RepoRoot 'skills'
$TargetRoot = Join-Path $HOME '.claude/skills'

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
    throw "Source directory not found: $SourceRoot. Run 'npm run build:skills' from the repo root first."
}

if (-not (Test-Path -LiteralPath $TargetRoot -PathType Container)) {
    Write-Host "Creating $TargetRoot"
    New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null
}

foreach ($name in $SkillNames) {
    $src = Join-Path $SourceRoot $name
    $dst = Join-Path $TargetRoot $name

    if (-not (Test-Path -LiteralPath $src -PathType Container)) {
        throw "Source skill not found: $src. Run 'npm run build:skills' from the repo root first."
    }

    if (Test-Path -LiteralPath $dst) {
        Write-Host "Removing existing $dst"
        Remove-Item -LiteralPath $dst -Recurse -Force
    }

    Write-Host "Copying $src -> $dst"
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force
}

Write-Host "Installed skills: $($SkillNames -join ', ') -> $TargetRoot"
