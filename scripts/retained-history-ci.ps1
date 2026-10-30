# Dot-source only: functions for hosted Retained History acceptance lane.
Set-StrictMode -Version Latest

if (-not (Get-Command Assert-ExpectedCommit -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'installer-candidate-artifacts.ps1')
}
if (-not (Get-Command Get-FileSha256 -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'installer-manifest.ps1')
}

$script:OwnedAppProcessInfo = $null

function Assert-RetainedHistoryCiHost {
    param(
        [Parameter(Mandatory)][string]$ExpectedCommit,
        [Parameter(Mandatory)][string]$RepoRoot
    )

    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OS -ne 'Windows_NT') {
        throw 'Retained History gate is restricted to a disposable GitHub-hosted Windows runner.'
    }
    if ($env:GITHUB_EVENT_NAME -ne 'workflow_dispatch') {
        throw 'Retained History gate requires workflow_dispatch manual trigger.'
    }
    if ($env:GITHUB_REF -ne 'refs/heads/trunk') {
        throw "Retained History gate is restricted to trunk, observed ref: $env:GITHUB_REF"
    }
    if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE -or -not $env:GITHUB_SHA) {
        throw 'Required GitHub Actions runner temp or workspace variables are missing.'
    }

    $workspace = [System.IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    if (-not $workspace.Equals([System.IO.Path]::GetFullPath($RepoRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The script must run from the checked-out GitHub workspace.'
    }

    $root = [System.IO.Path]::GetPathRoot($workspace)
    if (-not $root.Equals([System.IO.Path]::GetPathRoot($env:RUNNER_TEMP), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runner temp and workspace must share the same volume.'
    }

    if ($ExpectedCommit -cne $env:GITHUB_SHA) {
        throw "ExpectedCommit ($ExpectedCommit) does not match GITHUB_SHA ($env:GITHUB_SHA)."
    }

    Assert-ExpectedCommit -Commit $ExpectedCommit -RepoRoot $RepoRoot

    $candidateCommit = '555e303092ddd18f14c7a29723acaa4806c3f2e1'
    if ($ExpectedCommit.ToLowerInvariant() -eq $candidateCommit) {
        Write-Step "Note: Harness commit matches candidate source commit $candidateCommit."
    }
}

function Get-RetainedCandidatePins {
    return [ordered]@{
        RunId                 = '40751101623'
        ArtifactId            = '12844806461'
        CandidateCommit       = '555e303092ddd18f14c7a29723acaa4806c3f2e1'
        CandidateVersion      = '0.8.2-alpha.8'
        ZipSha256             = '19b180bbd9becdc19889a8a80dfb65cca3ddc54dc45e707d79761273cb6046dc'
        ManifestSha256        = '54c5dc7a2d599074735aa2dd97aa6737c67cc7c1ed6c0532a921e778a2bcc876'
        PayloadManifestSha256 = 'af28cfdb89bc6c4ae84f00d2c6dd345a3ec5e4f25be58f5e7f9f72df3f8f7bd0'
        Files = [ordered]@{
            'Eve.Web.Setup.0.8.2-alpha.8.exe'          = '94f01264f473f9643d4b25537e7287321346c8a5ed393a9eab6644fce6f0345e'
            'murmur-0.8.2-alpha.8-x64.nsis.7z'         = '27e4d32672ed618e5647fdcd4e35a156e756f7cb47a6704bbb1a530373befeb8'
            'eve-v0.8.2-alpha.8-artifact-manifest.json' = '54c5dc7a2d599074735aa2dd97aa6737c67cc7c1ed6c0532a921e778a2bcc876'
            'latest.yml'                               = 'b8f5762667e128f066e885ab7f90cf40f5eaa2ce1482a90ab4acebb9a06a9e84'
            'THIRD_PARTY_NOTICES.txt'                  = '5bcd8c54d7dbeba506d516ef48c4753fb4663f51232ce1da172c570015b39e4b'
            'SHA256SUMS.txt'                           = '10bd59d9d4bacee7238c51f50cb8d4797738d7dce47e32dd9c129085ba8e2d20'
            'SHA512SUMS.txt'                           = 'eeae353330b9ddc164d354d85fa9963f58fa7e3a657da5c339369c95046240a1'
            'qa/candidate-payload-manifest.json'       = 'af28cfdb89bc6c4ae84f00d2c6dd345a3ec5e4f25be58f5e7f9f72df3f8f7bd0'
            'qa/candidate-provenance.json'             = 'c0e21aaeb15d702778acd54a13dc5e463f73d8164070e402ae177d45bfba7fe2'
            'qa/candidate-phase-status.json'           = '5938fa5569db4f16a1fb86c49aca99d0144c217601d052d166933b464723cab3'
        }
    }
}

function Save-RetainedHistoryCandidate {
    param(
        [Parameter(Mandatory)][string]$RetainedDir
    )

    if (-not $env:RUNNER_TEMP) {
        throw 'RUNNER_TEMP environment variable is required.'
    }

    $targetFull = [System.IO.Path]::GetFullPath($RetainedDir)
    $runnerTempFull = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
    $repoRootFull = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

    if (-not $targetFull.StartsWith("$runnerTempFull$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'RetainedDir must be within RUNNER_TEMP.'
    }
    if ($targetFull.StartsWith("$repoRootFull$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -or
        $repoRootFull.StartsWith("$targetFull$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -or
        $targetFull.Equals($repoRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'RetainedDir must stay outside the checkout workspace.'
    }

    if (Test-Path -LiteralPath $targetFull) {
        $existingItems = @(Get-ChildItem -LiteralPath $targetFull -Force)
        if ($existingItems.Count -gt 0) {
            throw "Target directory already exists and is non-empty: $targetFull (collision refusal)"
        }
    } else {
        New-Item -ItemType Directory -Path $targetFull -Force | Out-Null
    }

    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        throw 'curl.exe is required for artifact download.'
    }

    $pins = Get-RetainedCandidatePins
    $runId = $pins.RunId
    $repository = 'burntcookiedough/eve-windows-dictation'
    $artifactId = $pins.ArtifactId
    $expectedSourceCommit = $pins.CandidateCommit
    $expectedZipSha = $pins.ZipSha256
    $expectedArtifactSize = [int64]212886597

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI required for artifact identity verification.' }
    & {
        $json = & gh api "repos/$repository/actions/runs/$runId"
        if ($LASTEXITCODE -ne 0) { throw 'Candidate run metadata unavailable.' }
        $runMeta = $json | ConvertFrom-Json
        if ($runMeta.head_sha.ToLowerInvariant() -ne $expectedSourceCommit.ToLowerInvariant()) {
            throw "Artifact run head_sha mismatch: expected $expectedSourceCommit, got $($runMeta.head_sha)"
        }
        if ($runMeta.status -ne 'completed' -or $runMeta.conclusion -ne 'success') {
            throw "Artifact run status is not successful: status=$($runMeta.status), conclusion=$($runMeta.conclusion)"
        }

        $json = & gh api "repos/$repository/actions/artifacts/$artifactId"
        if ($LASTEXITCODE -ne 0) { throw 'Candidate artifact metadata unavailable.' }
        $artMeta = $json | ConvertFrom-Json
        if ($artMeta.expired -ne $false -or [string]$artMeta.workflow_run.id -ne $runId -or
            $artMeta.workflow_run.head_sha -cne $expectedSourceCommit -or $artMeta.digest -cne "sha256:$expectedZipSha") { throw 'Candidate artifact identity rejected.' }
        if ([int64]$artMeta.size_in_bytes -ne $expectedArtifactSize) {
            throw "Artifact size mismatch: expected $expectedArtifactSize, got $($artMeta.size_in_bytes)"
        }
    }

    $zipPath = Join-Path $targetFull 'candidate-artifact.zip'
    try {
        $downloadUrl = "https://api.github.com/repos/$repository/actions/artifacts/$artifactId/zip"
        $headers = @(
            '-H', 'Accept: application/vnd.github+json',
            '-H', "Authorization: Bearer $env:GH_TOKEN"
        )
        & curl.exe -f -s -S -L --max-time 1800 @headers $downloadUrl -o $zipPath
        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe download failed with exit code $LASTEXITCODE"
        }

        $actualZipSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualZipSha -ne $expectedZipSha.ToLowerInvariant()) {
            throw "Downloaded artifact ZIP SHA-256 mismatch: expected $expectedZipSha, got $actualZipSha"
        }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zipArchive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $entryNames = @($zipArchive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
            $expectedNames = @($pins.Files.Keys)
            if ($entryNames.Count -ne 10) {
                throw "Expected exactly 10 ZIP entries, got $($entryNames.Count)"
            }
            foreach ($name in $entryNames) {
                if ($name -notin $expectedNames) {
                    throw "Unexpected entry in candidate artifact ZIP: $name"
                }
                if ($name -match '\.\.' -or $name.StartsWith('/')) {
                    throw "Invalid entry path in candidate artifact ZIP: $name"
                }
            }
            foreach ($name in $expectedNames) {
                if ($name -notin $entryNames) {
                    throw "Missing expected entry in candidate artifact ZIP: $name"
                }
            }
        } finally {
            $zipArchive.Dispose()
        }

        [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $targetFull)
        Write-Host "[retained-history] Successfully downloaded and extracted retained candidate artifact ($artifactId)."
    } finally {
        if (Test-Path -LiteralPath $zipPath) {
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-RetainedCandidateStaging {
    param(
        [Parameter(Mandatory)][string]$RetainedDir,
        [Parameter(Mandatory)][string]$CandidateArtifactDir
    )

    $pins = Get-RetainedCandidatePins
    $retainedFull = [System.IO.Path]::GetFullPath($RetainedDir)
    if (-not (Test-Path -LiteralPath $retainedFull -PathType Container)) {
        throw 'Retained candidate directory does not exist.'
    }

    $allFiles = @(Get-ChildItem -LiteralPath $retainedFull -Recurse -File)
    foreach ($f in $allFiles) {
        if ($f.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
            throw 'Retained candidate directory contains reparse points.'
        }
    }

    $actualRelativePaths = @($allFiles | ForEach-Object {
        $_.FullName.Substring($retainedFull.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
    })

    $expectedRelativePaths = @($pins.Files.Keys)
    $missing = @($expectedRelativePaths | Where-Object { $_ -notin $actualRelativePaths })
    $unexpected = @($actualRelativePaths | Where-Object { $_ -notin $expectedRelativePaths })
    if ($missing.Count -gt 0 -or $unexpected.Count -gt 0) {
        throw 'Retained candidate file allowlist mismatch'
    }

    foreach ($relativePath in $expectedRelativePaths) {
        $fullPath = Join-Path $retainedFull ($relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        $actualHash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $expectedHash = $pins.Files[$relativePath].ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Retained candidate hash mismatch for ${relativePath}: expected $expectedHash, got $actualHash"
        }
    }

    $releaseScript = Join-Path $script:RepoRoot 'scripts/release-artifacts.ps1'
    $global:LASTEXITCODE = 0
    & $releaseScript -Mode Verify -ArtifactDir $retainedFull -ExpectedTag "v$($pins.CandidateVersion)" -ExpectedCommit $pins.CandidateCommit -ExpectedManifestSha256 $pins.ManifestSha256 -AllowUnsigned
    if ($LASTEXITCODE -ne 0) {
        throw 'Retained candidate release verification failed; refusing to stage artifacts.'
    }

    $stagedItems = @(
        @("Eve.Web.Setup.$($pins.CandidateVersion).exe", "Eve.Web.Setup.$($pins.CandidateVersion).exe"),
        @("murmur-$($pins.CandidateVersion)-x64.nsis.7z", "murmur-$($pins.CandidateVersion)-x64.nsis.7z"),
        @('qa/candidate-payload-manifest.json', 'candidate-payload-manifest.json'),
        @('latest.yml', 'latest.yml')
    )

    foreach ($pair in $stagedItems) {
        $src = Join-Path $retainedFull ($pair[0] -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        $dst = Join-Path $CandidateArtifactDir $pair[1]
        Copy-Item -LiteralPath $src -Destination $dst -Force
    }

    Write-Step 'Retained candidate artifacts verified against pinned cryptographic digests and staged for test execution.'
}

function Assert-NodeWebSocketCapability {
    $code = @'
if (typeof globalThis.WebSocket !== 'function') {
    process.exit(2);
}
process.exit(0);
'@
    $res = & node -e $code
    if ($LASTEXITCODE -ne 0) {
        throw 'Node 22+ built-in WebSocket capability check failed; environment lacks required native WebSocket.'
    }
    Write-Step 'Verified Node 22+ built-in WebSocket support.'
}

function Initialize-PreseededSettings {
    param([Parameter(Mandatory)][string]$UserDataDir)

    if (-not (Test-Path -LiteralPath $UserDataDir)) {
        New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
    }
    $settingsPath = Join-Path $UserDataDir 'settings.json'
    [ordered]@{
        serverAutoStart = $false
        startMinimized  = $false
        appearance      = 'dark'
    } | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding utf8
    Write-Step "Pre-seeded isolated settings at $settingsPath (serverAutoStart: false, startMinimized: false, appearance: dark)."
}

function Initialize-SyntheticSentinels {
    param(
        [Parameter(Mandatory)][string]$UserDataDir,
        [Parameter(Mandatory)][string]$CacheRoot
    )

    if (-not (Test-Path -LiteralPath $UserDataDir)) {
        New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $CacheRoot)) {
        New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
    }

    Set-Content -LiteralPath (Join-Path $UserDataDir 'installer-lifecycle-sentinel.txt') -Value 'eve-alpha7-profile-sentinel' -NoNewline
    Set-Content -LiteralPath (Join-Path $CacheRoot 'installer-lifecycle-sentinel.txt') -Value 'eve-alpha7-cache-sentinel' -NoNewline
    Write-Step 'Initialized synthetic sentinels in profile and cache roots.'
}

function Invoke-HistoryDatabaseSeed {
    param(
        [Parameter(Mandatory)][string]$DbPath,
        [string]$PythonExe = 'python'
    )

    if (-not (Test-Path -LiteralPath $DbPath -PathType Leaf)) {
        throw "Target History database not found for seeding: $DbPath"
    }

    $seedScript = @'
import hashlib
import json
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
try:
    cur = conn.cursor()

    # 1. Integrity check before seed
    cur.execute("PRAGMA integrity_check;")
    check = cur.fetchall()
    if check != [("ok",)]:
        raise RuntimeError(f"Database integrity check failed before seed: {check}")

    # 2. Schema check
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='transcriptions';")
    if not cur.fetchall():
        raise RuntimeError("Table 'transcriptions' not found in initialized database")

    cur.execute("PRAGMA table_info(transcriptions);")
    cols = {row[1] for row in cur.fetchall()}
    required_cols = {"id", "timestamp", "text", "confidence", "audioDuration", "transcriptionTime", "wordCount"}
    missing = required_cols - cols
    if missing:
        raise RuntimeError(f"Transcriptions table is missing required columns: {missing}")

    cur.execute("SELECT COUNT(*) FROM transcriptions;")
    initial_count = cur.fetchone()[0]
    if initial_count != 0:
        raise RuntimeError(f"Expected empty transcriptions table before seed, found {initial_count} rows")

    # 3. Fixed fictional test records (minimal 7 known columns)
    rows = [
        ("fixture-hist-001", 1729000001000, "alpha functional history baseline entry one", 0.98, 3.5, 210, 6),
        ("fixture-hist-002-delete", 1729000002000, "beta designated delete entry two", 0.95, 2.8, 180, 5),
        ("fixture-hist-003", 1729000003000, "gamma persisted history baseline entry three", 0.99, 4.1, 250, 6),
    ]

    cur.executemany(
        """
        INSERT INTO transcriptions (
            id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
        ) VALUES (?, ?, ?, ?, ?, ?, ?);
        """,
        rows,
    )
    conn.commit()

    # 4. Integrity check after seed
    cur.execute("PRAGMA integrity_check;")
    check = cur.fetchall()
    if check != [("ok",)]:
        raise RuntimeError(f"Database integrity check failed after seed: {check}")

    records = [
        {
            "id": r[0],
            "timestamp": r[1],
            "textHash": hashlib.sha256(r[2].encode("utf-8")).hexdigest(),
        }
        for r in sorted(rows, key=lambda x: x[1], reverse=True)
    ]

    manifest = {
        "seededRowCount": len(rows),
        "seededIds": [r[0] for r in rows],
        "seededTextHashes": [hashlib.sha256(r[2].encode("utf-8")).hexdigest() for r in rows],
        "records": records,
        "status": "success",
    }
    print(json.dumps(manifest, separators=(",", ":")))
finally:
    conn.close()
'@

    $output = & $PythonExe -c $seedScript $DbPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to seed History database via Python sqlite3, exit code $LASTEXITCODE."
    }
    $manifest = ($output | Out-String | ConvertFrom-Json)
    Write-Step "Seeded $($manifest.seededRowCount) fixed fictional History rows into $DbPath."
    return $manifest
}

function Assert-SqliteIntegrity {
    param(
        [Parameter(Mandatory)][string]$DbPath,
        [string]$PythonExe = 'python'
    )
    if (-not (Test-Path -LiteralPath $DbPath -PathType Leaf)) {
        throw "Database file missing for integrity check: $DbPath"
    }
    $pyCheck = @'
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
try:
    cur = conn.cursor()
    cur.execute("PRAGMA integrity_check;")
    res = cur.fetchall()
    if res != [("ok",)]:
        raise RuntimeError(f"Readonly integrity check failed: {res}")
finally:
    conn.close()
'@
    $res = & $PythonExe -c $pyCheck $DbPath
    if ($LASTEXITCODE -ne 0) {
        throw "SQLite readonly integrity check failed on $DbPath"
    }
    Write-Step "SQLite readonly integrity verified on $DbPath."
}

function Get-EphemeralLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    return $port
}

function Launch-AppWithCdp {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$UserDataDir,
        [Parameter(Mandatory)][int]$CdpPort
    )

    $exePath = [System.IO.Path]::GetFullPath((Join-Path $InstallDir 'Eve.exe'))
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
        throw "Eve executable missing: $exePath"
    }

    $arguments = @(
        '--eve-qa-isolation',
        "--eve-qa-user-data-root=`"$UserDataDir`"",
        "--remote-debugging-port=$CdpPort",
        '--remote-debugging-address=127.0.0.1'
    )

    $proc = Start-Process -FilePath $exePath -ArgumentList $arguments -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru
    # Retain the original OS handle so exit status remains available after PID removal/reuse.
    if ($proc) { $null = $proc.Handle }
    if (-not $proc -or $proc.HasExited) {
        throw "Failed to start Eve app from $exePath"
    }

    $procId = $proc.Id
    $procStartTime = $proc.StartTime.ToUniversalTime().Ticks
    $procInfo = [pscustomobject]@{
        Id            = $procId
        CreationTicks = $procStartTime
        ExePath       = $exePath
        Process       = $proc
    }
    $script:OwnedAppProcessInfo = $procInfo
    $script:OwnedAppPid = $procId

    $deadline = (Get-Date).AddSeconds(30)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p -or $p.HasExited) {
            throw "Eve app process $procId exited prematurely during startup."
        }
        try {
            $ver = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 2 -ErrorAction Stop
            if ($ver -and $ver.webSocketDebuggerUrl) {
                $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $CdpPort -ErrorAction Stop)
                if (-not $listeners.Count -or @($listeners | Where-Object { $_.OwningProcess -ne $procId -or $_.LocalAddress -ne '127.0.0.1' }).Count) {
                    throw 'Debugger listener does not belong exclusively to the QA app on loopback.'
                }
                if ($p.StartTime.ToUniversalTime().Ticks -ne $procStartTime) { throw 'QA app PID identity changed.' }
                $ready = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $ready) {
        Stop-OwnedHistoryProcess
        throw "CDP endpoint did not become ready at http://127.0.0.1:$CdpPort within 30s."
    }

    Write-Step "Launched Eve (PID $procId) with loopback CDP debugging on port $CdpPort."
    return $procInfo
}

function Wait-ForOwnedProcessExit {
    param(
        [Parameter(Mandatory)]$ProcInfo,
        [int]$TimeoutSeconds = 30
    )

    $procId = [int]$ProcInfo.Id
    $process = $ProcInfo.Process
    if ($process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Refresh()
        $exitCode = $process.ExitCode
        $script:OwnedAppPid = $null
        $script:OwnedAppProcessInfo = $null
        if ($null -eq $exitCode -or $exitCode -ne 0) {
            throw "Process $procId returned a nonzero or unavailable exit code; graceful shutdown was not proved."
        }
        Write-Step "Process $procId exited gracefully with code 0."
        return
    }

    Stop-OwnedHistoryProcess
    throw "Process $procId did not exit gracefully within ${TimeoutSeconds}s."
}

function Stop-OwnedHistoryProcess {
    if ($null -ne $script:OwnedAppProcessInfo) {
        $procInfo = $script:OwnedAppProcessInfo
        $procId = [int]$procInfo.Id
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($p -and -not $p.HasExited) {
            if ($p.StartTime.ToUniversalTime().Ticks -eq [long]$procInfo.CreationTicks) {
                Stop-TestProcesses
            }
        }
        $script:OwnedAppProcessInfo = $null
        $script:OwnedAppPid = $null
    } else {
        Stop-TestProcesses
    }
}

function Invoke-RetainedHistoryProbe {
    param(
        [Parameter(Mandatory)][int]$CdpPort,
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$ExpectationsPath
    )

    $probeScript = Join-Path $script:RepoRoot 'scripts/retained-history-probe.mjs'
    if (-not (Test-Path -LiteralPath $probeScript -PathType Leaf)) {
        throw "CDP probe script missing: $probeScript"
    }

    $arguments = @(
        $probeScript,
        "--port=$CdpPort",
        "--phase=$Phase",
        "--install-dir=$InstallDir",
        "--expectations=$ExpectationsPath"
    )

    $output = & node @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "CDP probe failed in phase '$Phase': required packaged-app observation was not established."
    }

    $evidence = ($output | Out-String | ConvertFrom-Json)
    if ($evidence.status -ne 'passed' -or $evidence.closeRequested -ne $true) {
        throw "CDP probe phase '$Phase' did not pass or request graceful close."
    }

    Write-Step "CDP probe phase '$Phase' succeeded."
    return $evidence
}

function Observe-RetainedHistoryLaunch {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$UserDataDir,
        [Parameter(Mandatory)][string]$ExpectationsPath,
        [int]$CdpPort = 0
    )

    if ($CdpPort -eq 0) {
        $CdpPort = Get-EphemeralLoopbackPort
    }

    $procInfo = Launch-AppWithCdp -InstallDir $InstallDir -UserDataDir $UserDataDir -CdpPort $CdpPort
    $evidence = $null
    try {
        $evidence = Invoke-RetainedHistoryProbe -CdpPort $CdpPort -Phase $Phase -InstallDir $InstallDir -ExpectationsPath $ExpectationsPath
        Wait-ForOwnedProcessExit -ProcInfo $procInfo -TimeoutSeconds 30
    } catch {
        Stop-OwnedHistoryProcess
        throw
    }

    $dbPath = Join-Path $UserDataDir 'history.db'
    Assert-SqliteIntegrity -DbPath $dbPath

    return $evidence
}

function Set-FunctionalHistoryPhase {
    param(
        [Parameter(Mandatory)][string]$PhaseName,
        [Parameter(Mandatory)][ValidateSet('started', 'passed', 'failed')][string]$Status,
        [string]$ErrorDetail = '',
        [object]$Observations = $null
    )

    $phase = [ordered]@{
        status        = $Status
        recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    if ($ErrorDetail) {
        $phase['error'] = 'Generic error: phase failed'
    }
    if ($Observations) {
        $phase['observations'] = $Observations
    }

    $script:FunctionalHistoryEvidence.phases[$PhaseName] = $phase
    $script:FunctionalHistoryEvidence.currentPhase = $PhaseName

    if ($Status -eq 'failed') {
        $script:FunctionalHistoryEvidence.overallStatus = 'failed'
    }
}

function Write-FunctionalHistoryEvidence {
    param(
        [hashtable]$EvidenceData = $null
    )

    if ($null -eq $EvidenceData) {
        $EvidenceData = $script:FunctionalHistoryEvidence
    }

    $evidenceDir = Join-Path $script:RunRoot 'evidence'
    if (-not (Test-Path -LiteralPath $evidenceDir)) {
        New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    }

    $evidencePath = Join-Path $evidenceDir 'functional-history-evidence.json'
    $EvidenceData | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
    Write-Step "Wrote aggregate functional History evidence to $evidencePath."
}

function Invoke-RetainedHistoryCi {
    param(
        [string]$RetainedArtifactDir = $script:RetainedArtifactDir,
        [string]$ExpectedCommit = $script:ExpectedCommit
    )

    Write-Step 'Starting Retained History acceptance lifecycle.'
    Assert-RetainedHistoryCiHost -ExpectedCommit $ExpectedCommit -RepoRoot $script:RepoRoot
    Assert-NodeWebSocketCapability

    # Harness release versions may advance independently of the immutable candidate.
    $script:CandidateVersion = (Get-RetainedCandidatePins).CandidateVersion
    $script:FunctionalHistoryComplete = $false
    $script:FunctionalHistoryEvidence = [ordered]@{
        schema           = 1
        harnessCommit    = $ExpectedCommit
        candidateCommit  = '555e303092ddd18f14c7a29723acaa4806c3f2e1'
        candidateVersion = $script:CandidateVersion
        startTimeUtc     = [DateTimeOffset]::UtcNow.ToString('o')
        currentPhase     = 'candidate_verification'
        phases           = [ordered]@{}
        disclaimers      = [ordered]@{
            seeded       = $true
            newDictation = $false
            reboot       = $false
            mic          = $false
            editor       = $false
        }
        overallStatus    = 'started'
    }

    $userData = Join-Path $script:ProfileRoot 'Eve'
    $expectationsPath = Join-Path $script:RunRoot 'expectations.json'
    [ordered]@{ records = @() } | ConvertTo-Json | Set-Content -LiteralPath $expectationsPath -Encoding utf8

    $baselineInstaller = Join-Path $script:BaselineArtifactDir "Eve.Web.Setup.$script:BaselineVersion.exe"
    $candidateInstaller = Join-Path $script:CandidateArtifactDir "Eve.Web.Setup.$script:CandidateVersion.exe"

    try {
        Assert-NoNvidiaDriver

        Set-FunctionalHistoryPhase -PhaseName 'candidate_verification' -Status 'started'
        Assert-RetainedCandidateStaging -RetainedDir $RetainedArtifactDir -CandidateArtifactDir $script:CandidateArtifactDir
        Set-FunctionalHistoryPhase -PhaseName 'candidate_verification' -Status 'passed'

        Set-FunctionalHistoryPhase -PhaseName 'baseline_download' -Status 'started'
        Download-VerifiedBaseline -Destination $script:BaselineArtifactDir
        Set-FunctionalHistoryPhase -PhaseName 'baseline_download' -Status 'passed'

        Initialize-PreseededSettings -UserDataDir $userData
        Initialize-SyntheticSentinels -UserDataDir $userData -CacheRoot $script:CacheRoot

        Set-FunctionalHistoryPhase -PhaseName 'baseline_install' -Status 'started'
        Invoke-Installer -Installer $baselineInstaller -InstallDir $script:InstallDir
        Assert-Installed -Version $script:BaselineVersion
        Set-FunctionalHistoryPhase -PhaseName 'baseline_install' -Status 'passed'

        Set-FunctionalHistoryPhase -PhaseName 'baseline_initialize' -Status 'started'
        $obsInit = Observe-RetainedHistoryLaunch -Phase 'baseline-initialize' -InstallDir $script:InstallDir -UserDataDir $userData -ExpectationsPath $expectationsPath
        Set-FunctionalHistoryPhase -PhaseName 'baseline_initialize' -Status 'passed' -Observations $obsInit.observations

        Set-FunctionalHistoryPhase -PhaseName 'database_seed' -Status 'started'
        $dbPath = Join-Path $userData 'history.db'
        $seedManifest = Invoke-HistoryDatabaseSeed -DbPath $dbPath
        [ordered]@{ records = $seedManifest.records } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $expectationsPath -Encoding utf8
        Set-FunctionalHistoryPhase -PhaseName 'database_seed' -Status 'passed' -Observations $seedManifest

        Set-FunctionalHistoryPhase -PhaseName 'baseline_read' -Status 'started'
        $obsBaseRead = Observe-RetainedHistoryLaunch -Phase 'baseline-read' -InstallDir $script:InstallDir -UserDataDir $userData -ExpectationsPath $expectationsPath
        Set-FunctionalHistoryPhase -PhaseName 'baseline_read' -Status 'passed' -Observations $obsBaseRead.observations

        Set-FunctionalHistoryPhase -PhaseName 'candidate_upgrade' -Status 'started'
        Assert-RetainedCandidateStaging -RetainedDir $RetainedArtifactDir -CandidateArtifactDir $script:CandidateArtifactDir
        Invoke-Installer -Installer $candidateInstaller -InstallDir $script:InstallDir
        Assert-Installed -Version $script:CandidateVersion
        Set-FunctionalHistoryPhase -PhaseName 'candidate_upgrade' -Status 'passed'

        Set-FunctionalHistoryPhase -PhaseName 'candidate_upgrade_read_mutate' -Status 'started'
        $obsMutate = Observe-RetainedHistoryLaunch -Phase 'candidate-upgrade-read-mutate' -InstallDir $script:InstallDir -UserDataDir $userData -ExpectationsPath $expectationsPath
        Set-FunctionalHistoryPhase -PhaseName 'candidate_upgrade_read_mutate' -Status 'passed' -Observations $obsMutate.observations

        Set-FunctionalHistoryPhase -PhaseName 'candidate_relaunch_verify' -Status 'started'
        $obsRelaunch = Observe-RetainedHistoryLaunch -Phase 'candidate-relaunch-verify' -InstallDir $script:InstallDir -UserDataDir $userData -ExpectationsPath $expectationsPath
        Set-FunctionalHistoryPhase -PhaseName 'candidate_relaunch_verify' -Status 'passed' -Observations $obsRelaunch.observations

        Set-FunctionalHistoryPhase -PhaseName 'candidate_uninstall' -Status 'started'
        Uninstall-Current -Version $script:CandidateVersion
        Set-FunctionalHistoryPhase -PhaseName 'candidate_uninstall' -Status 'passed'

        Set-FunctionalHistoryPhase -PhaseName 'baseline_rollback_install' -Status 'started'
        Invoke-Installer -Installer $baselineInstaller -InstallDir $script:InstallDir
        Assert-Installed -Version $script:BaselineVersion
        Set-FunctionalHistoryPhase -PhaseName 'baseline_rollback_install' -Status 'passed'

        Set-FunctionalHistoryPhase -PhaseName 'baseline_rollback_read' -Status 'started'
        $obsRollback = Observe-RetainedHistoryLaunch -Phase 'baseline-rollback-read' -InstallDir $script:InstallDir -UserDataDir $userData -ExpectationsPath $expectationsPath
        Set-FunctionalHistoryPhase -PhaseName 'baseline_rollback_read' -Status 'passed' -Observations $obsRollback.observations

        Set-FunctionalHistoryPhase -PhaseName 'baseline_uninstall' -Status 'started'
        Uninstall-Current -Version $script:BaselineVersion
        Set-FunctionalHistoryPhase -PhaseName 'baseline_uninstall' -Status 'passed'

        Set-FunctionalHistoryPhase -PhaseName 'candidate_final_binding' -Status 'started'
        Assert-RetainedCandidateStaging -RetainedDir $RetainedArtifactDir -CandidateArtifactDir $script:CandidateArtifactDir
        Set-FunctionalHistoryPhase -PhaseName 'candidate_final_binding' -Status 'passed'

        $script:FunctionalHistoryComplete = $true
    } catch {
        Set-FunctionalHistoryPhase -PhaseName $script:FunctionalHistoryEvidence.currentPhase -Status 'failed'
        $script:FunctionalHistoryEvidence.overallStatus = 'failed'
        $script:FunctionalHistoryEvidence.error = 'Generic error: lifecycle execution failed.'
        throw
    } finally {
        $cleanupFailed = $false
        try {
            Stop-OwnedHistoryProcess
        } catch {
            $cleanupFailed = $true
            $script:FunctionalHistoryEvidence.overallStatus = 'failed'
            $script:FunctionalHistoryEvidence.error = 'Generic error: cleanup failed.'
        }

        if ($script:FunctionalHistoryEvidence.overallStatus -ne 'failed') {
            $allPassed = $true
            foreach ($p in $script:FunctionalHistoryEvidence.phases.Values) {
                if ($p.status -ne 'passed') { $allPassed = $false; break }
            }
            if ($allPassed -and $script:FunctionalHistoryComplete) {
                $script:FunctionalHistoryEvidence.overallStatus = 'passed'
            } else {
                $script:FunctionalHistoryEvidence.overallStatus = 'failed'
            }
        }
        $script:FunctionalHistoryEvidence.endTimeUtc = [DateTimeOffset]::UtcNow.ToString('o')
        Write-FunctionalHistoryEvidence -EvidenceData $script:FunctionalHistoryEvidence

        if ($cleanupFailed) {
            throw 'Generic error: cleanup failed.'
        }
    }
    if ($script:FunctionalHistoryEvidence.overallStatus -ne 'passed') { throw 'Functional History observations incomplete.' }
    Write-Step 'PASS: Retained candidate functional History acceptance lifecycle completed successfully.'
}
