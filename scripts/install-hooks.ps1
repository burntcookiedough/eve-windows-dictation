$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
git -C $repoRoot config core.hooksPath scripts/hooks
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
