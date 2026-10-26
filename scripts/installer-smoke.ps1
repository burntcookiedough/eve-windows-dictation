[CmdletBinding()]
param(
    [string]$InstallerPath,
    [string]$InstallDir = "$env:LOCALAPPDATA\Programs\Eve",
    [string]$Model = "",
    [int]$HealthTimeoutSec = 180,
    [int]$DownloadTimeoutSec = 1200,
    [string]$PidFilePath = "$env:APPDATA\Eve\server.pid",
    [string]$ExpectedVersion = "",
    [string]$ManifestPath = "",
    [switch]$SkipUninstall,
    [switch]$SkipLaunch,
    [switch]$RequireCuda,
    [switch]$RequireDriverMinimum,
    [switch]$RequireVcRedist,
    [switch]$RequireModelDownload
)

Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot "installer-manifest.ps1")
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
        $candidate = Get-ChildItem -Path $resolved -Filter "Eve*Setup*.exe" -File |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($candidate) { return $candidate.FullName }
    }

    return $null
}

function Get-SmokeTargetPaths {
    param([string[]]$Directories)
    foreach ($directory in $Directories) {
        foreach ($relative in @('Eve.exe', 'Murmur.exe', 'resources\server\.runtime\python.exe', 'resources\server\.venv\Scripts\python.exe')) {
            [IO.Path]::GetFullPath((Join-Path $directory $relative))
        }
    }
}

function Assert-SmokeTargetsIdle {
    param([string[]]$Directories)
    $paths = @(Get-SmokeTargetPaths -Directories $Directories)
    $candidates = Get-CimInstance -Query "SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name='Eve.exe' OR Name='Murmur.exe' OR Name='python.exe'" -ErrorAction Stop
    foreach ($candidate in $candidates) {
        if (-not $candidate.ExecutablePath) { throw 'Cannot verify target install trees are idle: a process path is inaccessible.' }
        if ([IO.Path]::GetFullPath($candidate.ExecutablePath) -in $paths) {
            throw 'A target app or backend is running. Close it explicitly before this smoke run; no existing session was stopped.'
        }
    }
}

function Get-SmokeProcessIdentity {
    param([System.Diagnostics.Process]$Process)
    # Pin the OS process object before reading identity or following child IDs.
    # Retain this handle through descendant cleanup, including after root exit.
    $null = $Process.SafeHandle
    return [pscustomobject]@{
        Process = $Process
        Id = $Process.Id
        Path = [IO.Path]::GetFullPath($Process.Path)
        Started = $Process.StartTime.ToUniversalTime()
    }
}

function Stop-SmokeOwnedTree {
    param($Identity, [string[]]$AllowedPaths, [int]$Depth = 0)
    if ($Depth -gt 16) { throw 'Smoke process ancestry exceeded its cleanup bound.' }
    $consoleHostPath = Join-Path ([Environment]::SystemDirectory) 'conhost.exe'
    $consoleHost = $Identity.Path -ieq $consoleHostPath
    if (-not $consoleHost -and $Identity.Path -notin $AllowedPaths) { throw 'Smoke child is outside the exact test install paths; refusing to stop it.' }
    $owned = $Identity.Process
    if (-not $owned.HasExited) {
        # Console hosts belong to Windows: wait for their clients to release them,
        # never terminate an executable outside the exact test install paths.
        if (-not $consoleHost) { $owned.Kill() }
        if (-not $owned.WaitForExit(5000)) { throw 'Test-owned smoke process did not exit.' }
    }
    # Stop a parent before enumerating: it cannot spawn more children now. Windows
    # retains each live child's original parent ID; the pinned parent handle keeps
    # that ID from being recycled while we validate and drain its descendants.
    $failures = [Collections.Generic.List[Exception]]::new()
    $ownedChildren = [Collections.Generic.List[object]]::new()
    $children = Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($Identity.Id)" -ErrorAction Stop
    foreach ($record in $children) {
        $child = $null
        try {
            $child = Get-Process -Id ([int]$record.ProcessId) -ErrorAction Stop
            $childIdentity = Get-SmokeProcessIdentity -Process $child
            $live = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($childIdentity.Id)" -ErrorAction Stop
            if (-not $live) { throw 'Smoke child exited before its ancestry could be verified.' }
            if ($live.ParentProcessId -ne $Identity.Id -or $childIdentity.Started -lt $Identity.Started) {
                throw 'Smoke child identity changed; refusing to stop it or claim complete cleanup.'
            }
            $ownedChildren.Add($childIdentity)
            $child = $null # Ownership of this pinned handle transfers to the list.
        } catch { $failures.Add($_.Exception) }
        finally { if ($child) { $child.Dispose() } }
    }
    try {
        # Pin sibling identities before stopping any: a console can exit as soon
        # as its last Python client does. Release consoles after those clients.
        foreach ($childIdentity in ($ownedChildren | Sort-Object { $_.Path -ieq $consoleHostPath })) {
            try { Stop-SmokeOwnedTree -Identity $childIdentity -AllowedPaths $AllowedPaths -Depth ($Depth + 1) }
            catch { $failures.Add($_.Exception) }
        }
    } finally { foreach ($childIdentity in $ownedChildren) { $childIdentity.Process.Dispose() } }
    if ($failures.Count) { throw [AggregateException]::new('Smoke descendant cleanup could not be verified.', $failures) }
}

function Resolve-UninstallerPaths {
    param([string[]]$Directories)

    foreach ($directory in ($Directories | Select-Object -Unique)) {
        foreach ($name in @("Uninstall Eve.exe", "Uninstall Murmur.exe")) {
            $candidate = Join-Path $directory $name
            if (Test-Path $candidate) {
                $candidate
            }
        }
    }
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

function Wait-For-PidFile {
    param([string]$Path, [int]$TimeoutSec, [long]$StartedAfter)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $Path) {
            try {
                $pidData = Get-Content -Path $Path -Raw | ConvertFrom-Json
                if ($pidData.pid -and $pidData.port -and $pidData.startedAt -ge $StartedAfter) {
                    return $pidData
                }
            } catch {
                Start-Sleep -Milliseconds 500
                continue
            }
        }

        Start-Sleep -Seconds 1
    }

    throw "PID file was not written within ${TimeoutSec}s at $Path."
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

$PidFilePath = [System.IO.Path]::GetFullPath($PidFilePath)
$qaUserDataRoot = Split-Path -Parent $PidFilePath
if ((Split-Path -Leaf $qaUserDataRoot) -ne "Eve") {
    throw "PidFilePath must be inside an Eve QA profile directory: $PidFilePath"
}
$qaAppDataRoot = Split-Path -Parent $qaUserDataRoot
New-Item -ItemType Directory -Path $qaAppDataRoot -Force | Out-Null

$resolvedInstaller = Resolve-InstallerPath -ExplicitPath $InstallerPath
if (-not $resolvedInstaller) {
    throw "Installer not found. Pass -InstallerPath or ensure app/release has an Eve Setup*.exe."
}

Write-Step "Using installer: $resolvedInstaller"

$legacyInstallDir = "$env:LOCALAPPDATA\Programs\murmur"
$targetDirectories = @($InstallDir)
if (-not $SkipUninstall) { $targetDirectories += $legacyInstallDir }
Write-Step "Checking that the target install trees are idle"
Assert-SmokeTargetsIdle -Directories $targetDirectories

if (-not $SkipUninstall) {
    $uninstallers = @(Resolve-UninstallerPaths -Directories @($InstallDir, $legacyInstallDir))
    foreach ($uninstaller in $uninstallers) {
        Write-Step "Uninstalling existing Eve or legacy Murmur installation at $uninstaller"
        $uninstallProc = Start-Process -Wait -FilePath $uninstaller -ArgumentList "/S" -PassThru
        Assert-ExitCode -Process $uninstallProc -Step "Uninstall $uninstaller"
    }
}

$hfHome = Join-Path $env:LOCALAPPDATA "Eve\hf-smoke"
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
$env:MURMUR_ENGINE = "whisper"
Write-Step "Setting MURMUR_ENGINE=whisper"

if (Test-Path $PidFilePath) {
    Write-Step "Removing stale PID file at $PidFilePath"
    Remove-Item -Path $PidFilePath -Force
}

Write-Step "Installing Eve"
$installProc = Start-Process -Wait -FilePath $resolvedInstaller -ArgumentList @("/S", "/D=$InstallDir") -PassThru
Assert-ExitCode -Process $installProc -Step "Install"

$exePath = Join-Path $InstallDir "Eve.exe"
if (-not (Test-Path $exePath)) {
    throw "Installed app not found at $exePath"
}

if ($ManifestPath) {
    Write-Step "Verifying installed files against payload manifest at $ManifestPath"
    Assert-InstalledPayload -InstallDir $InstallDir -ManifestPath $ManifestPath | Out-Null
} else {
    Write-Step "No payload manifest provided (-ManifestPath); installed payload byte/hash verification unverified."
}

if ($SkipLaunch) {
    Write-Step "Skipping launch (SkipLaunch enabled)"
    exit 0
}

$launchStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Write-Step "Launching Eve"
$launchTimeUtc = (Get-Date).ToUniversalTime()
$launchArguments = @(
    "--eve-qa-isolation",
    "--eve-qa-user-data-root=`"$qaUserDataRoot`""
)
$process = $null
$ownedLauncher = $null
$allowedSmokePaths = @(Get-SmokeTargetPaths -Directories @($InstallDir))

try {
    $process = Start-Process -FilePath $exePath -ArgumentList $launchArguments -WorkingDirectory $InstallDir -PassThru -WindowStyle Hidden
    $ownedLauncher = Get-SmokeProcessIdentity -Process $process
    Write-Step "Waiting for server PID file at $PidFilePath"
    $pidData = Wait-For-PidFile -Path $PidFilePath -TimeoutSec $HealthTimeoutSec -StartedAfter $launchStartedAt
    $healthUrl = "http://127.0.0.1:$($pidData.port)/health"
    Write-Step "Waiting for server health at $healthUrl"
    $health = Wait-For-Health -Url $healthUrl -TimeoutSec $HealthTimeoutSec

    if ($ExpectedVersion -and $health.version -ne $ExpectedVersion) {
        throw "Version mismatch: expected $ExpectedVersion, got $($health.version)"
    }

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
} catch {
    Write-Warning "Smoke checks failed: $($_.Exception.Message)"
    throw
} finally {
    Write-Step "Stopping this smoke run's owned app and backend"
    try {
        if ($ownedLauncher) { Stop-SmokeOwnedTree -Identity $ownedLauncher -AllowedPaths $allowedSmokePaths }
        elseif ($process) { throw 'Launcher identity was not captured; descendant cleanup is unverified.' }
    } finally { if ($process) { $process.Dispose() } }
}

Write-Step "Smoke test complete"
