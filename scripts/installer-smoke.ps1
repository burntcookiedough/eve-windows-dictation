[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Murmur",
    [string]$Model = "tiny",
    [int]$HealthTimeoutSec = 180,
    [int]$DownloadTimeoutSec = 1200,
    [switch]$SkipUninstall,
    [switch]$SkipLaunch,
    [switch]$RequireCuda,
    [switch]$RequireDriverMinimum,
    [switch]$RequireVcRedist,
    [switch]$RequireModelDownload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[smoke] $Message"
}

function Assert-ExitCode {
    param([System.Diagnostics.Process]$Process, [string]$Step)
    if ($Process.ExitCode -ne 0) {
        throw "$Step failed with exit code $($Process.ExitCode)."
    }
}

function Resolve-InstallerPath {
    param([string]$ExplicitPath)

    if ($ExplicitPath -and (Test-Path $ExplicitPath)) {
        return (Resolve-Path $ExplicitPath).Path
    }

    $roots = @(
        (Join-Path $PSScriptRoot "..\app\release"),
        (Join-Path (Get-Location) "app\release")
    )

    foreach ($root in $roots) {
        $resolved = Resolve-Path $root -ErrorAction SilentlyContinue
        if (-not $resolved) { continue }
        $candidate = Get-ChildItem -Path $resolved -Filter "Murmur Setup*.exe" -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }

    return $null
}

function Stop-MurmurProcesses {
    Get-Process -Name "Murmur" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Wait-For-Health {
    param([string]$Url, [int]$TimeoutSec)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 10
        } catch {
            Start-Sleep -Seconds 2
        }
    }

    throw "Server did not become healthy within ${TimeoutSec}s."
}

function Wait-For-Model {
    param([string]$Url, [int]$TimeoutSec)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $lastState = $null
    while ((Get-Date) -lt $deadline) {
        $payload = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 10
        $state = $payload.model_download
        if ($null -eq $state) {
            Start-Sleep -Seconds 3
            continue
        }

        $lastState = $state
        if ($state.status -eq "ready") {
            return $state
        }
        if ($state.status -eq "error") {
            $detail = $state.detail
            throw "Model download failed: $detail"
        }

        Start-Sleep -Seconds 5
    }

    $lastJson = $lastState | ConvertTo-Json -Compress
    throw "Model download did not reach ready within ${TimeoutSec}s. Last state: $lastJson"
}

if ($env:OS -ne "Windows_NT") {
    throw "This script must be run on Windows."
}

$resolvedInstaller = Resolve-InstallerPath -ExplicitPath $InstallerPath
if (-not $resolvedInstaller) {
    throw "Installer not found. Pass -InstallerPath or ensure app/release has a Murmur Setup*.exe."
}

Write-Step "Using installer: $resolvedInstaller"

if (-not $SkipUninstall) {
    Write-Step "Stopping any running Murmur processes"
    Stop-MurmurProcesses

    $uninstaller = Join-Path $InstallDir "Uninstall Murmur.exe"
    if (Test-Path $uninstaller) {
        Write-Step "Uninstalling existing Murmur"
        $uninstallProc = Start-Process -Wait -FilePath $uninstaller -ArgumentList "/S" -PassThru
        Assert-ExitCode -Process $uninstallProc -Step "Uninstall"
    }
}

$hfHome = Join-Path $env:LOCALAPPDATA "Murmur\hf-smoke"
$env:HF_HOME = $hfHome
$env:HF_HUB_CACHE = Join-Path $hfHome "hub"

if (Test-Path $hfHome) {
    Write-Step "Clearing Hugging Face cache at $hfHome"
    Remove-Item -Path $hfHome -Recurse -Force
}
New-Item -ItemType Directory -Path $hfHome | Out-Null

if ($Model) {
    $env:MURMUR_WHISPER_MODEL = $Model
    Write-Step "Setting MURMUR_WHISPER_MODEL=$Model"
}

Write-Step "Installing Murmur"
$installProc = Start-Process -Wait -FilePath $resolvedInstaller -ArgumentList "/S" -PassThru
Assert-ExitCode -Process $installProc -Step "Install"

if ($SkipLaunch) {
    Write-Step "Skipping launch (SkipLaunch enabled)"
    exit 0
}

$exePath = Join-Path $InstallDir "Murmur.exe"
if (-not (Test-Path $exePath)) {
    throw "Installed app not found at $exePath"
}

Write-Step "Launching Murmur"
$process = Start-Process -FilePath $exePath -WorkingDirectory $InstallDir -PassThru

try {
    $healthUrl = "http://127.0.0.1:51717/health"
    Write-Step "Waiting for server health at $healthUrl"
    $health = Wait-For-Health -Url $healthUrl -TimeoutSec $HealthTimeoutSec

    $diagnostics = $health.diagnostics
    if (-not $diagnostics) {
        throw "Health response missing diagnostics payload."
    }

    $cuda = $diagnostics.cuda
    $cudaDlls = $diagnostics.cuda_dlls
    $driver = $diagnostics.nvidia_driver
    $vcRedist = $diagnostics.vc_redist

    Write-Step "Diagnostics: CUDA=$($cuda.available) device=$($cuda.device) cuda_dlls=$($cudaDlls.available) driver=$($driver.version) meets_minimum=$($driver.meets_minimum) vc_redist=$($vcRedist.installed)"

    if ($diagnostics.warnings) {
        foreach ($warning in $diagnostics.warnings) {
            Write-Step "Warning: $($warning.code) - $($warning.message)"
        }
    }

    if ($RequireVcRedist -and $vcRedist.installed -ne $true) {
        throw "VC++ redist check failed (installed=$($vcRedist.installed))."
    }
    if ($RequireCuda -and $cuda.available -ne $true) {
        throw "CUDA check failed (available=$($cuda.available))."
    }
    if ($RequireCuda -and $cudaDlls.available -ne $true) {
        throw "CUDA DLL check failed (available=$($cudaDlls.available))."
    }
    if ($RequireDriverMinimum -and $driver.meets_minimum -ne $true) {
        throw "NVIDIA driver minimum check failed (meets_minimum=$($driver.meets_minimum))."
    }

    Write-Step "Waiting for model download state"
    $state = Wait-For-Model -Url $healthUrl -TimeoutSec $DownloadTimeoutSec
    Write-Step "Model download status=$($state.status) cached=$($state.cached) detail=$($state.detail)"

    if ($Model -and $state.model -and $state.model -ne $Model) {
        throw "Model mismatch: expected $Model, got $($state.model)"
    }
    if ($RequireModelDownload -and $state.detail -ne "downloaded") {
        throw "Expected a fresh download, but detail=$($state.detail)"
    }
} finally {
    Write-Step "Stopping Murmur"
    if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}

Write-Step "Smoke test complete"
