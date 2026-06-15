$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$skillsDir = Join-Path $root "skills"
$outDir = Join-Path $root "..\sparsi"

if (-not (Test-Path $skillsDir)) {
    Write-Error "skills/ directory not found - run 'npm run build:skills' first"
    exit 1
}

foreach ($skill in @("sparsi-design", "sparsi-codegen")) {
    $src = Join-Path $skillsDir $skill
    $dst = Join-Path $outDir "$skill.zip"

    if (-not (Test-Path $src)) {
        Write-Error "Expected skill directory not found: $src"
        exit 1
    }

    Compress-Archive -Path $src -DestinationPath $dst -Force
    Write-Host "wrote $dst"
}
