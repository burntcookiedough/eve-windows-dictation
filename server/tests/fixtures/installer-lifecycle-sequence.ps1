param([string]$LifecycleScript, [string]$Root, [string]$Mode)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($LifecycleScript, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Lifecycle script did not parse.' }
$sequence = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] })
if ($sequence.Count -ne 1) { throw 'Expected exactly one top-level lifecycle sequence.' }
$allowed = @('Write-Step','Invoke-Installer','Assert-Installed','Launch-And-Verify','Set-Content',
    'Assert-SyntheticSentinels','Invoke-InstalledCpuInference','Uninstall-Current','Stop-TestProcesses',
    'Join-Path','New-Item','Out-Null','Test-Path','Split-Path','Get-Content',
    'Assert-CandidateBinding','Set-CandidatePhaseStatus','Assert-NoNvidiaDriver',
    'Move-And-CleanBuildOutput','Download-VerifiedBaseline')
foreach ($command in $sequence[0].FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    if ($command.GetCommandName() -notin $allowed) { throw "Unexpected command in extracted lifecycle sequence: $($command.GetCommandName())" }
}
$sentinels = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-SyntheticSentinels' }, $false)
if ($sentinels.Count -ne 1) { throw 'Expected the real sentinel verifier.' }
Invoke-Expression $sentinels[0].Extent.Text
$script:RunRoot = $Root
$script:ProfileRoot = Join-Path $Root 'profile'
$script:CacheRoot = Join-Path $Root 'cache'
$script:InstallDir = Join-Path $Root 'install'
$script:CurrentInstallDir = $script:InstallDir
$script:BaselineVersion = 'baseline'
$script:CandidateVersion = 'candidate'
$script:CandidateArtifactDir = Join-Path $Root 'candidate'
$script:BaselineArtifactDir = Join-Path $Root 'baseline'
$script:RetainedArtifactDir = Join-Path $Root 'retained'
$candidateStatusPath = Join-Path $script:RetainedArtifactDir 'qa/candidate-phase-status.json'
New-Item -ItemType Directory -Path $script:CandidateArtifactDir, $script:BaselineArtifactDir, (Split-Path $candidateStatusPath) | Out-Null
@{ overallStatus = 'staged'; currentPhase = 'candidate_artifacts_prepared'; phases = @{} } | ConvertTo-Json | Set-Content $candidateStatusPath
. (Join-Path $PSScriptRoot '../../../scripts/installer-candidate-artifacts.ps1')
$baselineInstaller = 'baseline'
$candidateInstaller = 'candidate'
New-Item -ItemType Directory -Path $script:ProfileRoot, $script:CacheRoot | Out-Null
$profileSentinel = Join-Path $script:ProfileRoot 'Eve/installer-lifecycle-sentinel.txt'
$originalSentinel = $profileSentinel
Set-Content (Join-Path $script:CacheRoot 'installer-lifecycle-sentinel.txt') 'eve-alpha7-cache-sentinel' -NoNewline
$script:installed = ''
$script:cleanLaunch = $false
$script:cleanInference = $false
$script:cleanRemoval = $false
$script:stopped = $false
$script:passPrinted = $false
function Write-Step { param($Message) if ($Message -like 'PASS:*') { $script:passPrinted = $true } }
function Stop-TestProcesses {
    $script:stopped = $true
    if ($Mode -eq 'cleanup-failure') { throw 'Synthetic owned cleanup failed.' }
}
$script:events = @()
function Assert-CandidateBinding {
    param($CandidateInstaller=$script:candidateInstaller, $CandidatePayload=$script:candidatePayload)
    $script:events += "binding|$CandidateInstaller|$CandidatePayload"
}
function Assert-NoNvidiaDriver {}
function Move-And-CleanBuildOutput {
    param($CandidateDir)
    foreach ($name in @('Eve.Web.Setup.0.8.2-alpha.8.exe', 'murmur-0.8.2-alpha.8-x64.nsis.7z')) { Set-Content (Join-Path $CandidateDir $name) 'synthetic' }
}
function Download-VerifiedBaseline {
    param($Destination)
    if ($Mode -eq 'baseline-download-failure') { throw 'Synthetic pinned baseline download failed.' }
    foreach ($name in @('Eve.Web.Setup.0.8.2-alpha.5.exe', 'murmur-0.8.2-alpha.5-x64.nsis.7z')) { Set-Content (Join-Path $Destination $name) 'synthetic' }
}
function Invoke-Installer {
    param($Installer, $InstallDir)
    if ($Installer -notin @($baselineInstaller, $candidateInstaller)) { throw 'Unknown synthetic installer argument.' }
    $kind = if ($Installer -eq $candidateInstaller) { 'candidate' } else { 'baseline' }
    $script:events += "install:$kind"
    $script:clean = $kind -eq 'candidate' -and $script:installed -eq ''
    if ($script:clean -and (Test-Path (Join-Path $script:ProfileRoot 'Eve'))) { throw 'Clean candidate reused an existing profile.' }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Set-Content (Join-Path $InstallDir 'Eve.exe') $kind
    $script:installed = $kind
}
function Assert-Installed {
    param($Version)
    if ($script:installed -ne $Version -or (Get-Content (Join-Path $script:CurrentInstallDir 'Eve.exe') -Raw).Trim() -ne $Version) { throw 'Synthetic installed version mismatch.' }
}
function Launch-And-Verify {
    param($Version)
    Assert-Installed $Version
    if ($script:clean) {
        if ($Mode -eq 'launch-failure') { throw 'Synthetic fresh candidate launch failed.' }
        $script:cleanLaunch = $true
    }
    New-Item -ItemType Directory -Path (Join-Path $script:ProfileRoot 'Eve') -Force | Out-Null
}
function Invoke-InstalledCpuInference { if ($script:clean) { $script:cleanInference = $true } }
function Uninstall-Current {
    param($Version)
    Assert-Installed $Version
    Assert-SyntheticSentinels
    Remove-Item -LiteralPath (Join-Path $script:CurrentInstallDir 'Eve.exe')
    $script:installed = ''
    if ($script:clean) { $script:cleanRemoval = $true }
    if ($script:clean -and $Mode -eq 'earlier-profile-removed') {
        Remove-Item -LiteralPath $originalSentinel
    }
    if ($script:clean -and $Mode -eq 'earlier-profile-changed') {
        Set-Content -LiteralPath $originalSentinel -Value 'changed synthetic evidence'
    }
    if ($Version -eq 'baseline' -and $Mode -in @('existing-profile', 'existing-install')) {
        $name = if ($Mode -eq 'existing-profile') { 'clean-profile' } else { 'clean-install' }
        $existing = Join-Path $Root $name
        New-Item -ItemType Directory -Path $existing | Out-Null
        Set-Content (Join-Path $existing 'preserve.txt') 'existing synthetic evidence'
    }
}
$failure = $null
$failureRecord = $null
try { Invoke-Expression $sequence[0].Extent.Text } catch { $failureRecord = $_; $failure = $_.Exception.Message }
if (-not $script:stopped) { throw 'Lifecycle finally did not stop owned test processes.' }
if ($Mode -eq 'success' -and -not $failure) {
    $terminal = @($ast.EndBlock.Statements | Where-Object { $_.Extent.StartOffset -gt $sequence[0].Extent.EndOffset -and $_.Extent.Text -eq "Set-CandidatePhaseStatus -PhaseName 'overall' -Status 'passed'" })
    if ($terminal.Count -ne 1) { throw 'Expected exactly one terminal overall-pass write.' }
    Invoke-Expression $terminal[0].Extent.Text
}
$phaseData = Get-Content $candidateStatusPath -Raw | ConvertFrom-Json -AsHashtable
if ($Mode -notin @('earlier-profile-removed', 'earlier-profile-changed', 'baseline-download-failure') -and (Get-Content -LiteralPath $originalSentinel -Raw) -ne 'eve-alpha7-profile-sentinel') { throw 'Original profile evidence changed.' }
if ($Mode -eq 'success') {
    if ($failure) { throw $failure }
    if (-not ($script:cleanLaunch -and $script:cleanInference -and $script:cleanRemoval)) { throw 'Candidate clean install, launch, inference and removal were not all exercised.' }
    if ($script:ProfileRoot -eq (Join-Path $Root 'profile')) { throw 'Candidate did not receive a fresh profile.' }
    if ($phaseData.overallStatus -ne 'passed' -or $phaseData.phases.overall.status -ne 'passed') { throw 'Candidate overall status was not passed.' }
    if ($phaseData.phases.baseline_download.status -ne 'passed') { throw 'Baseline download phase was not recorded as passed.' }
    $candidateInstalls = @(for ($i = 0; $i -lt $script:events.Count; $i++) { if ($script:events[$i] -eq 'install:candidate') { $i } })
    if ($candidateInstalls.Count -ne 2) { throw 'Expected two candidate installs in the lifecycle sequence.' }
    $expectedInstaller = Join-Path $script:CandidateArtifactDir 'Eve.Web.Setup.0.8.2-alpha.8.exe'
    $expectedPayload = Join-Path $script:CandidateArtifactDir 'murmur-0.8.2-alpha.8-x64.nsis.7z'
    $expectedBinding = "binding|$expectedInstaller|$expectedPayload"
    foreach ($i in $candidateInstalls) {
        if ($i -eq 0 -or $script:events[$i - 1] -ne $expectedBinding) { throw 'Candidate installer ran without an immediately preceding binding check for the candidate installer and payload.' }
    }
    Assert-SyntheticSentinels
} else {
    if (-not $failure) { throw 'Expected the isolated lifecycle phase to fail closed.' }
    if ($phaseData.overallStatus -ne 'failed') { throw 'Failed lifecycle phase did not retain a failed overall status.' }
    if ($script:passPrinted) { throw 'Failed lifecycle phase reported PASS.' }
    if ($script:cleanRemoval -and $Mode -notin @('earlier-profile-removed', 'earlier-profile-changed', 'cleanup-failure')) { throw 'Failed clean phase was reported as complete.' }
    if ($Mode -in @('earlier-profile-removed', 'earlier-profile-changed') -and $failure -notmatch 'Earlier profile sentinel') { throw $failure }
    if ($Mode -eq 'launch-failure' -and $failure -notmatch 'Synthetic fresh candidate launch failed') { throw $failure }
    if ($Mode -eq 'cleanup-failure' -and ($failure -notmatch 'Synthetic owned cleanup failed' -or $phaseData.phases.cleanup.status -ne 'failed' -or $phaseData.overallStatus -ne 'failed')) { throw 'Cleanup failure was not recorded as failed.' }
    if ($Mode -eq 'baseline-download-failure' -and ($failure -notmatch 'Synthetic pinned baseline download failed' -or $phaseData.phases.baseline_download.status -ne 'failed' -or $phaseData.phases.overall.error -notmatch 'Synthetic pinned baseline download failed')) { throw 'Original download failure was not recorded by the real lifecycle handler.' }
    if ($Mode -in @('existing-profile', 'existing-install')) {
        $name = if ($Mode -eq 'existing-profile') { 'clean-profile' } else { 'clean-install' }
        $expectedConflict = [System.IO.Path]::GetFullPath((Join-Path $Root $name))
        if ($failureRecord.FullyQualifiedErrorId -ne 'DirectoryExist,Microsoft.PowerShell.Commands.NewItemCommand' -or
            -not $expectedConflict.Equals([System.IO.Path]::GetFullPath([string]$failureRecord.TargetObject), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Expected collision rejection for the pre-existing lifecycle path.'
        }
        if ((Get-Content (Join-Path $expectedConflict 'preserve.txt') -Raw).Trim() -ne 'existing synthetic evidence') { throw 'Existing evidence was overwritten.' }
    }
}
Write-Output "SEQUENCE_PROOF=$Mode"
