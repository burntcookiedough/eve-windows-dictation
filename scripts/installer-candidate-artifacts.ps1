# Dot-source only: these helpers never run an installer.
Set-StrictMode -Version Latest

function Assert-ExpectedCommit {
    param([Parameter(Mandatory)][string]$Commit, [Parameter(Mandatory)][string]$RepoRoot)
    if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw 'ExpectedCommit must be a lowercase 40-character SHA.' }
    $head = & git -C $RepoRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $head) { throw 'Cannot verify candidate source HEAD.' }
    if ($head.Trim() -cne $Commit) { throw 'ExpectedCommit does not match git HEAD.' }
}

function Get-CandidateRuntimeVersion {
    param([Parameter(Mandatory)][string]$WinUnpackedDir)
    $python = Join-Path $WinUnpackedDir 'resources/server/.runtime/python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Bundled candidate Python is missing.' }
    $version = & $python -B -I -c 'import sys; print(sys.version.split()[0])'
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^3\.11\.\d+$') { throw 'Cannot identify bundled candidate Python3.11.' }
    return $version.Trim()
}

function New-CandidateArtifactSet {
    param(
        [Parameter(Mandatory)][string]$SourceBuildDir,
        [Parameter(Mandatory)][string]$WinUnpackedDir,
        [Parameter(Mandatory)][string]$LegalNoticesFile,
        [Parameter(Mandatory)][string]$TargetDir,
        [Parameter(Mandatory)][string]$CandidateVersion,
        [Parameter(Mandatory)][string]$ExpectedCommit,
        [Parameter(Mandatory)][string]$RepoRoot
    )
    Assert-ExpectedCommit -Commit $ExpectedCommit -RepoRoot $RepoRoot
    if ($CandidateVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid candidate version.' }
    if (Test-Path -LiteralPath $TargetDir) { throw 'Target candidate artifact directory already exists and is not empty or owned by an earlier attempt.' }
    $runtimeVersion = Get-CandidateRuntimeVersion -WinUnpackedDir $WinUnpackedDir
    Assert-SevenZipArchiveMethods -ArchivePath (Join-Path $SourceBuildDir "murmur-$CandidateVersion-x64.nsis.7z") -AppDir (Join-Path $RepoRoot 'app')
    New-Item -ItemType Directory -Path $TargetDir | Out-Null
    $names = @("Eve.Web.Setup.$CandidateVersion.exe", "murmur-$CandidateVersion-x64.nsis.7z", 'latest.yml', 'THIRD_PARTY_NOTICES.txt')
    foreach ($name in $names) {
        $source = if ($name -eq 'THIRD_PARTY_NOTICES.txt') { $LegalNoticesFile } else { Join-Path $SourceBuildDir $name }
        Copy-Item -LiteralPath $source -Destination (Join-Path $TargetDir $name) -ErrorAction Stop
    }
    foreach ($algorithm in @('SHA256','SHA512')) {
        @(foreach ($name in $names) { "{0} *{1}" -f (Get-FileHash -LiteralPath (Join-Path $TargetDir $name) -Algorithm $algorithm).Hash.ToLowerInvariant(), $name }) |
            Set-Content -LiteralPath (Join-Path $TargetDir "$($algorithm)SUMS.txt") -Encoding ascii
    }
    $releaseScript = Join-Path $RepoRoot 'scripts/release-artifacts.ps1'
    & $releaseScript -Mode Create -ArtifactDir $TargetDir -ExpectedTag "v$CandidateVersion" -ExpectedCommit $ExpectedCommit
    $manifest = Join-Path $TargetDir "eve-v$CandidateVersion-artifact-manifest.json"
    $manifestHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
    & $releaseScript -Mode Verify -ArtifactDir $TargetDir -ExpectedTag "v$CandidateVersion" -ExpectedCommit $ExpectedCommit -ExpectedManifestSha256 $manifestHash -AllowUnsigned
    $qa = Join-Path $TargetDir 'qa'
    New-Item -ItemType Directory -Path $qa | Out-Null
    New-InstalledPayloadManifest -SourceDir $WinUnpackedDir -OutputFile (Join-Path $qa 'candidate-payload-manifest.json')
    [ordered]@{
        schema=1;tag="v$CandidateVersion";commit=$ExpectedCommit;version=$CandidateVersion
        manifestSha256=$manifestHash
        payloadManifestSha256=(Get-FileHash -LiteralPath (Join-Path $qa 'candidate-payload-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
        build=@{signed=$false;allowUnsigned=$true;publish='never';target='nsis-web'}
        tools=@{node=(& node --version);bun=(& bun --version);uv=(& uv --version);bundledPython=$runtimeVersion}
        runId=$env:GITHUB_RUN_ID;createdAtUtc=[DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $qa 'candidate-provenance.json') -Encoding utf8
    [ordered]@{
        schema=1;commit=$ExpectedCommit;version=$CandidateVersion;overallStatus='staged';currentPhase='candidate_artifacts_prepared'
        phases=@{candidate_artifacts_prepared=@{status='passed'}}
        disclaimers=@{functionalHistoryProof=$false;physicalMicAcceptance=$false;syntheticSentinelsOnly=$true}
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $qa 'candidate-phase-status.json') -Encoding utf8
}

function Assert-CandidateBinding {
    param(
        [string]$CandidateInstaller=$script:candidateInstaller,
        [string]$CandidatePayload=$script:candidatePayload,
        [string]$RetainedDir=$script:RetainedArtifactDir,
        [string]$CandidateVersion=$script:CandidateVersion,
        [string]$RepoRoot=(Split-Path -Parent $PSScriptRoot)
    )
    $qa = Join-Path $RetainedDir 'qa'
    $provenance = Get-Content -LiteralPath (Join-Path $qa 'candidate-provenance.json') -Raw | ConvertFrom-Json
    Assert-ExpectedCommit -Commit $provenance.commit -RepoRoot $RepoRoot
    if ($provenance.schema -ne 1 -or $provenance.version -ne $CandidateVersion) { throw 'Candidate provenance identity mismatch.' }
    & (Join-Path $RepoRoot 'scripts/release-artifacts.ps1') -Mode Verify -ArtifactDir $RetainedDir -ExpectedTag "v$CandidateVersion" -ExpectedCommit $provenance.commit -ExpectedManifestSha256 $provenance.manifestSha256 -AllowUnsigned
    foreach ($pair in @(
        @($CandidateInstaller, (Join-Path $RetainedDir "Eve.Web.Setup.$CandidateVersion.exe")),
        @($CandidatePayload, (Join-Path $RetainedDir "murmur-$CandidateVersion-x64.nsis.7z")),
        @((Join-Path (Split-Path -Parent $CandidateInstaller) 'candidate-payload-manifest.json'), (Join-Path $qa 'candidate-payload-manifest.json'))
    )) {
        if ((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $pair[1] -Algorithm SHA256).Hash) { throw 'Candidate bytes do not match retained copy.' }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $qa 'candidate-payload-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $provenance.payloadManifestSha256) { throw 'Candidate payload manifest hash mismatch.' }
}

function Set-CandidatePhaseStatus {
    param(
        [string]$RetainedDir=$script:RetainedArtifactDir,
        [Parameter(Mandatory)][string]$PhaseName,
        [Parameter(Mandatory)][ValidateSet('started','passed','failed')][string]$Status,
        [string]$ErrorDetail=''
    )
    $path = Join-Path $RetainedDir 'qa/candidate-phase-status.json'
    $data = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
    if ($PhaseName -eq 'overall' -and $Status -eq 'passed' -and $data.overallStatus -eq 'failed') { return }
    $recordedOverall = $data.phases['overall']
    if ($PhaseName -eq 'overall' -and $Status -eq 'failed' -and $recordedOverall -and $recordedOverall.status -eq 'failed' -and $recordedOverall['error']) { return }
    $phase = @{status=$Status;recordedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')}
    if ($ErrorDetail) {
        foreach ($root in @($env:GITHUB_WORKSPACE,$env:RUNNER_TEMP)) { if ($root) { $ErrorDetail=$ErrorDetail -replace [regex]::Escape($root),'<qa-root>' } }
        $phase.error = ($ErrorDetail -replace '[A-Za-z]:\\Users\\[^\\\s]+','<user-home>')
    }
    if ($PhaseName -ne 'overall') { $data.currentPhase=$PhaseName }
    if ($PhaseName -eq 'overall' -and $Status -eq 'failed' -and $data.overallStatus -ne 'failed' -and $data.currentPhase) { $data.phases[$data.currentPhase]=$phase }
    $data.phases[$PhaseName]=$phase
    if ($Status -eq 'failed') { $data.overallStatus='failed' }
    elseif ($PhaseName -eq 'overall' -and $Status -eq 'passed' -and $data.overallStatus -ne 'failed') { $data.overallStatus='passed' }
    $data | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding utf8
}
