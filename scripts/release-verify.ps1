[CmdletBinding()]
param(
    [string]$ExpectedVersion = "0.6.0",
    [string]$InstallerDir = "E:\MurmurRelease\release-prep\full-nsis-web\nsis-web",
    [string]$InstallDir = "E:\MurmurRelease\release-prep\smoke-install\Murmur",
    [string]$BaseBranch = "trunk",
    [int]$HealthPort = 8765,
    [int]$HealthTimeoutSec = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[verify] $Message"
}

function Assert-Path {
    param([string]$Path, [string]$Description)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description not found at $Path"
    }
}

function Assert-Contains {
    param([string]$Value, [string]$Expected, [string]$Description)
    if ($Value -notlike "*$Expected*") {
        throw "$Description did not contain '$Expected'. Value: $Value"
    }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Wait-For-Health {
    param([string]$Url, [int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Uri $Url -TimeoutSec 2
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    throw "Server did not become healthy within ${TimeoutSec}s at $Url"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

Write-Step "Checking repository version metadata"
Push-Location $repoRoot
try {
    Invoke-Native python scripts\version.py check --tag "v$ExpectedVersion"

    Write-Step "Checking merge viability against $BaseBranch"
    Invoke-Native git fetch origin $BaseBranch --quiet
    $mergeBase = & git merge-base HEAD "origin/$BaseBranch"
    if ($LASTEXITCODE -ne 0 -or -not $mergeBase) {
        throw "Could not find merge base between HEAD and origin/$BaseBranch"
    }
    $mergeTree = & git merge-tree $mergeBase "origin/$BaseBranch" HEAD
    if ($LASTEXITCODE -ne 0) {
        throw "git merge-tree failed for origin/$BaseBranch"
    }
    $conflicts = $mergeTree | Select-String -Pattern "<<<<<<<|changed in both|added in both"
    if ($conflicts) {
        throw "Merge simulation against origin/$BaseBranch reported conflicts."
    }
} finally {
    Pop-Location
}

$setupExe = Join-Path $InstallerDir "Murmur Web Setup $ExpectedVersion.exe"
$payload7z = Join-Path $InstallerDir "murmur-$ExpectedVersion-x64.nsis.7z"
$latestYml = Join-Path $InstallerDir "latest.yml"

Write-Step "Checking installer artifact set"
Assert-Path $setupExe "Installer"
Assert-Path $payload7z "NSIS web payload"
Assert-Path $latestYml "latest.yml"
Assert-Contains -Value (Get-Content -LiteralPath $latestYml -Raw) -Expected $ExpectedVersion -Description "latest.yml"

Write-Step "Checking installed payload contents"
$appExe = Join-Path $InstallDir "Murmur.exe"
$serverRoot = Join-Path $InstallDir "resources\server"
$pythonExe = Join-Path $serverRoot ".venv\Scripts\python.exe"
Assert-Path $appExe "Installed Murmur.exe"
Assert-Path $pythonExe "Bundled Python"
Assert-Path (Join-Path $serverRoot ".venv\Lib\site-packages\faster_whisper") "faster-whisper package"
Assert-Path (Join-Path $serverRoot ".venv\Lib\site-packages\torch") "torch package"
Assert-Path (Join-Path $serverRoot ".venv\Lib\site-packages\nemo") "nemo package"

Write-Step "Checking installed server health/version"
$outLog = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server.out.log"
$errLog = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server.err.log"
$pidFile = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server.pid"
Remove-Item -LiteralPath $outLog,$errLog,$pidFile -ErrorAction SilentlyContinue

$oldEnv = @{
    MURMUR_PID_FILE = $env:MURMUR_PID_FILE
    MURMUR_PORT = $env:MURMUR_PORT
    MURMUR_ENGINE = $env:MURMUR_ENGINE
    MURMUR_ENGINE_PREFERENCE_MODE = $env:MURMUR_ENGINE_PREFERENCE_MODE
    MURMUR_WHISPER_MODEL = $env:MURMUR_WHISPER_MODEL
    MURMUR_WHISPER_DEVICE = $env:MURMUR_WHISPER_DEVICE
    MURMUR_LOG_LEVEL = $env:MURMUR_LOG_LEVEL
}

$env:MURMUR_PID_FILE = $pidFile
$env:MURMUR_PORT = [string]$HealthPort
$env:MURMUR_ENGINE = "whisper"
$env:MURMUR_ENGINE_PREFERENCE_MODE = "manual"
$env:MURMUR_WHISPER_MODEL = "tiny"
$env:MURMUR_WHISPER_DEVICE = "cpu"
$env:MURMUR_LOG_LEVEL = "INFO"

$process = Start-Process -FilePath $pythonExe `
    -ArgumentList @("src\main.py") `
    -WorkingDirectory $serverRoot `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

try {
    $health = Wait-For-Health -Url "http://127.0.0.1:$HealthPort/health" -TimeoutSec $HealthTimeoutSec
    if ($health.version -ne $ExpectedVersion) {
        throw "Health version mismatch: expected $ExpectedVersion, got $($health.version)"
    }
    Write-Step "Health OK: version=$($health.version) status=$($health.status)"
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
    foreach ($key in $oldEnv.Keys) {
        Set-Item -Path "env:$key" -Value $oldEnv[$key] -ErrorAction SilentlyContinue
    }
}

Write-Step "Release verification complete"
