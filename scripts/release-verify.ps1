[CmdletBinding()]
param(
    [string]$ExpectedVersion = "0.8.2-alpha.6",
    [string]$InstallerDir = "E:\EveRelease\release-prep\full-nsis-web\nsis-web",
    [string]$InstallDir = "E:\EveRelease\release-prep\smoke-install\Eve",
    [string]$BaseBranch = "trunk",
    [int]$HealthPort = 8765,
    [int]$HealthTimeoutSec = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$InstallerDir = [System.IO.Path]::GetFullPath($InstallerDir)
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

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

function Assert-NoPackage {
    param([string]$SitePackages, [string]$Description)
    $forbidden = @(Get-ChildItem -LiteralPath $SitePackages -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "nemo" -or
            $_.Name -like "nemo_toolkit-*.dist-info" -or
            $_.Name -eq "torchaudio" -or
            $_.Name -like "torchaudio-*.dist-info" -or
            $_.Name -eq "torch" -or
            $_.Name -like "torch-*.dist-info" -or
            $_.Name -eq "nvidia" -or
            $_.Name -like "nvidia_*-*.dist-info"
        })
    if ($forbidden.Count -gt 0) {
        throw "$Description found: $($forbidden.Name -join ', ')"
    }
}

function Assert-NoPath {
    param([string]$Path, [string]$Description)
    if (Test-Path -LiteralPath $Path) {
        throw "$Description found at $Path"
    }
}

function Assert-Contains {
    param([string]$Value, [string]$Expected, [string]$Description)
    if ($Value -notlike "*$Expected*") {
        throw "$Description did not contain '$Expected'. Value: $Value"
    }
}

function Test-PathWithin {
    param([string]$Path, [string]$Root)
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    return $resolvedPath.StartsWith("$resolvedRoot$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedPath.Equals($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SelfContainedRuntime {
    param([string]$RuntimePath, [string]$PythonExe)
    $probeScript = 'import json, sys; print(json.dumps({"prefix": sys.prefix, "base_prefix": sys.base_prefix, "executable": sys.executable, "path": sys.path}))'
    $probe = & $PythonExe -I -c $probeScript
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled Python isolation probe failed with exit code $LASTEXITCODE"
    }
    $runtimeProbe = $probe | ConvertFrom-Json
    foreach ($property in @("prefix", "base_prefix", "executable")) {
        $value = [string]$runtimeProbe.$property
        if (-not (Test-PathWithin -Path $value -Root $RuntimePath)) {
            throw "Bundled Python $property resolves outside the runtime: $value"
        }
    }
    foreach ($entry in @($runtimeProbe.path)) {
        $value = [string]$entry
        if (-not [System.IO.Path]::IsPathRooted($value) -or -not (Test-PathWithin -Path $value -Root $RuntimePath)) {
            throw "Bundled Python sys.path entry resolves outside the runtime: $value"
        }
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

function Get-OptionalProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Wait-For-ReadyHealth {
    param(
        [string]$Url,
        [int]$TimeoutSec,
        [string]$ExpectedModel
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri $Url -TimeoutSec 2
        } catch {
            Start-Sleep -Milliseconds 500
            continue
        }

        $engine = Get-OptionalProperty $health "engine"
        $engineStatus = Get-OptionalProperty $engine "status"
        $engineInfo = Get-OptionalProperty $engine "info"
        $modelDownload = Get-OptionalProperty $health "model_download"
        $downloadStatus = Get-OptionalProperty $modelDownload "status"

        if ($engineStatus -eq "error") {
            throw "Packaged model preparation failed: $(Get-OptionalProperty $engine 'message')"
        }
        if ($downloadStatus -eq "error") {
            throw "Packaged model download failed: $(Get-OptionalProperty $modelDownload 'detail')"
        }
        if (
            $engineStatus -eq "ready" -and
            (Get-OptionalProperty $engineInfo "model") -eq $ExpectedModel -and
            $downloadStatus -eq "ready"
        ) {
            return $health
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Packaged model did not become ready within ${TimeoutSec}s at $Url"
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

$setupExe = Join-Path $InstallerDir "Eve.Web.Setup.$ExpectedVersion.exe"
$payload7z = Join-Path $InstallerDir "murmur-$ExpectedVersion-x64.nsis.7z"
$latestYml = Join-Path $InstallerDir "latest.yml"

Write-Step "Checking installer artifact set"
Assert-Path $setupExe "Installer"
Assert-Path $payload7z "NSIS web payload"
Assert-Path $latestYml "latest.yml"
Assert-Contains -Value (Get-Content -LiteralPath $latestYml -Raw) -Expected $ExpectedVersion -Description "latest.yml"

Write-Step "Checking installed payload contents"
$appExe = Join-Path $InstallDir "Eve.exe"
$serverRoot = Join-Path $InstallDir "resources\server"
$pythonExe = Join-Path $serverRoot ".runtime\python.exe"
$sitePackages = Join-Path $serverRoot ".venv\Lib\site-packages"
Assert-Path $appExe "Installed Eve.exe"
Assert-Path $pythonExe "Bundled Python"
Assert-Path (Join-Path $sitePackages "faster_whisper") "faster-whisper package"
Assert-NoPackage -SitePackages $sitePackages -Description "Unsupported model-runtime packages"
$cudnnDispatcher = Join-Path $sitePackages "ctranslate2\cudnn64_9.dll"
Assert-Path $cudnnDispatcher "Pinned CTranslate2 cuDNN dispatcher"
$dispatcherFile = Get-Item -LiteralPath $cudnnDispatcher
$dispatcherHash = (Get-FileHash -LiteralPath $cudnnDispatcher -Algorithm SHA256).Hash.ToLowerInvariant()
if ($dispatcherFile.Length -ne 266288 -or
    $dispatcherHash -ne "9edbcdff73b0af070eb160b2ce66e59feca04aa017351d8eedcc5e8e149967d2") {
    throw "Pinned CTranslate2 cuDNN dispatcher differs from the reviewed wheel."
}
$cudaRuntimeDlls = @(Get-ChildItem -LiteralPath $sitePackages -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -match '^(cublas|cudnn|cudart|cufft|curand|cusolver|cusparse|nvrtc|nvjitlink).*\.dll$' -and
        -not $_.FullName.Equals($cudnnDispatcher, [System.StringComparison]::OrdinalIgnoreCase)
    })
if ($cudaRuntimeDlls.Count -gt 0) {
    throw "CUDA runtime DLLs found in CPU base: $($cudaRuntimeDlls.FullName -join ', ')"
}
foreach ($relativePath in @(
    "src\transcription\engines\nemotron.py",
    "src\transcription\nemotron_runtime.py"
)) {
    Assert-NoPath -Path (Join-Path $serverRoot $relativePath) -Description "Retired model-runtime source"
}
Assert-SelfContainedRuntime -RuntimePath (Join-Path $serverRoot ".runtime") -PythonExe $pythonExe

Write-Step "Checking installed server health/version"
$outLog = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server.out.log"
$errLog = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server.err.log"
$pidFile = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server.pid"
Remove-Item -LiteralPath $outLog,$errLog,$pidFile -ErrorAction SilentlyContinue

$oldEnv = @{
    MURMUR_PID_FILE = $env:MURMUR_PID_FILE
    MURMUR_SETTINGS_FILE = $env:MURMUR_SETTINGS_FILE
    MURMUR_PORT = $env:MURMUR_PORT
    MURMUR_ENGINE = $env:MURMUR_ENGINE
    MURMUR_WHISPER_MODEL = $env:MURMUR_WHISPER_MODEL
    MURMUR_WHISPER_DEVICE = $env:MURMUR_WHISPER_DEVICE
    MURMUR_WHISPER_COMPUTE_TYPE = $env:MURMUR_WHISPER_COMPUTE_TYPE
    MURMUR_LOG_LEVEL = $env:MURMUR_LOG_LEVEL
    PYTHONNOUSERSITE = $env:PYTHONNOUSERSITE
    PYTHONPATH = $env:PYTHONPATH
}

$env:MURMUR_PID_FILE = $pidFile
$env:MURMUR_SETTINGS_FILE = Join-Path (Split-Path $InstallDir -Parent) "release-verify-server-settings.json"
$env:MURMUR_PORT = [string]$HealthPort
$env:MURMUR_ENGINE = "whisper"
$env:MURMUR_WHISPER_MODEL = "tiny"
$env:MURMUR_WHISPER_DEVICE = "cpu"
$env:MURMUR_WHISPER_COMPUTE_TYPE = "int8"
$env:MURMUR_LOG_LEVEL = "INFO"
$env:PYTHONNOUSERSITE = "1"
$env:PYTHONPATH = $sitePackages
Invoke-Native $pythonExe -c "import faster_whisper, ctranslate2; import importlib.util; assert importlib.util.find_spec('torch') is None"

Write-Step "Checking packaged Faster-Whisper catalog"
$catalogProbe = @"
import json
import sys

sys.path.insert(0, r"$serverRoot\src")
from transcription.factory import discover_models

models = discover_models()
if len(models) != 1 or models[0]["id"] != "whisper" or not models[0]["available"]:
    raise SystemExit(f"Unexpected Faster-Whisper catalog: {models!r}")
print(json.dumps({"id": models[0]["id"], "available": bool(models[0]["available"])}, sort_keys=True))
"@
$catalogOutput = & $pythonExe -c $catalogProbe
if ($LASTEXITCODE -ne 0) {
    throw "Packaged Faster-Whisper catalog probe failed with exit code $LASTEXITCODE"
}
$catalog = $catalogOutput | ConvertFrom-Json
if ($catalog.id -ne "whisper" -or -not [bool]$catalog.available) {
    throw "Packaged Faster-Whisper catalog mismatch: id=$($catalog.id) available=$($catalog.available)"
}

$process = Start-Process -FilePath $pythonExe `
    -ArgumentList @("src\main.py") `
    -WorkingDirectory $serverRoot `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

try {
    $health = Wait-For-ReadyHealth `
        -Url "http://127.0.0.1:$HealthPort/health" `
        -TimeoutSec $HealthTimeoutSec `
        -ExpectedModel $env:MURMUR_WHISPER_MODEL
    if ($health.version -ne $ExpectedVersion) {
        throw "Health version mismatch: expected $ExpectedVersion, got $($health.version)"
    }
    Write-Step "Health OK: version=$($health.version) engine=$($health.engine.status) model=$($health.engine.info.model)"
} finally {
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
    foreach ($key in $oldEnv.Keys) {
        if ($null -eq $oldEnv[$key]) { Remove-Item -Path "env:$key" -ErrorAction SilentlyContinue }
        else { Set-Item -Path "env:$key" -Value $oldEnv[$key] -ErrorAction Stop }
    }
}

Write-Step "Release verification complete"
