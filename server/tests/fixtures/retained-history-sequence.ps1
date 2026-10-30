param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Mode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Retained History script did not parse.' }

$invokeFn = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RetainedHistoryCi' }, $true))
if ($invokeFn.Count -ne 1) { throw 'Expected exactly one Invoke-RetainedHistoryCi function.' }

$sequence = @($invokeFn[0].Body.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] })
if ($sequence.Count -ne 1) { throw 'Expected exactly one try statement in Invoke-RetainedHistoryCi.' }

$allowed = @(
    'Write-Step', 'Assert-NoNvidiaDriver', 'Set-FunctionalHistoryPhase',
    'Assert-RetainedCandidateStaging', 'Download-VerifiedBaseline',
    'Initialize-PreseededSettings', 'Initialize-SyntheticSentinels',
    'Invoke-Installer', 'Assert-Installed', 'Observe-RetainedHistoryLaunch',
    'Invoke-HistoryDatabaseSeed', 'Uninstall-Current', 'Assert-CandidateBinding',
    'Stop-OwnedHistoryProcess', 'Write-FunctionalHistoryEvidence',
    'Join-Path', 'New-Item', 'Out-Null', 'Test-Path', 'Split-Path', 'Get-Content', 'Set-Content', 'Copy-Item',
    'ConvertTo-Json'
)
foreach ($command in $sequence[0].FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    if ($command.GetCommandName() -notin $allowed) {
        throw "Unexpected command in extracted sequence: $($command.GetCommandName())"
    }
}

$script:RunRoot = $Root
$script:ProfileRoot = Join-Path $Root 'profile'
$script:CacheRoot = Join-Path $Root 'hf'
$script:InstallDir = Join-Path $Root 'install\Programs\Eve'
$script:CurrentInstallDir = $script:InstallDir
$script:CandidateArtifactDir = Join-Path $Root 'candidate'
$script:BaselineArtifactDir = Join-Path $Root 'baseline'
$script:RetainedArtifactDir = Join-Path $Root 'retained'
$script:BaselineVersion = '0.8.2-alpha.5'
$script:CandidateVersion = '0.8.2-alpha.8'
$script:ExpectedCommit = '555e303092ddd18f14c7a29723acaa4806c3f2e1'
$script:RepoRoot = $Root
$script:Installed = ''
$script:Events = @()
$script:InstallDirs = @()
$script:InstallerPaths = @()
$script:Stopped = $false
$script:FunctionalHistoryComplete = $false

$evidenceDir = Join-Path $script:RunRoot 'evidence'
New-Item -ItemType Directory -Path $evidenceDir, $script:ProfileRoot, $script:CacheRoot, $script:CandidateArtifactDir, $script:BaselineArtifactDir -Force | Out-Null
$evidencePath = Join-Path $evidenceDir 'functional-history-evidence.json'

$script:FunctionalHistoryEvidence = [ordered]@{
    schema           = 1
    harnessCommit    = $script:ExpectedCommit
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
$candidateAssignments = @($invokeFn[0].Body.EndBlock.Statements | Where-Object {
    $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $_.Left.VariablePath.UserPath -eq 'candidateInstaller'
})
if ($candidateAssignments.Count -ne 1) { throw 'Expected exactly one production candidateInstaller assignment.' }
foreach ($command in $candidateAssignments[0].FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    if ($command.GetCommandName() -ne 'Join-Path') { throw 'Unexpected command in candidate installer assignment.' }
}
Invoke-Expression $candidateAssignments[0].Extent.Text

function Write-Step { param($Message) }
function Assert-NoNvidiaDriver { }

function Set-FunctionalHistoryPhase {
    param($PhaseName, $Status, $ErrorDetail='', $Observations=$null)
    $phase = [ordered]@{
        status = $Status
        recordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    if ($ErrorDetail) { $phase['error'] = 'Generic error: phase failed' }
    if ($Observations) { $phase['observations'] = $Observations }
    $script:FunctionalHistoryEvidence.phases[$PhaseName] = $phase
    $script:FunctionalHistoryEvidence.currentPhase = $PhaseName
    if ($Status -eq 'failed') {
        $script:FunctionalHistoryEvidence.overallStatus = 'failed'
    }
}

function Assert-RetainedCandidateStaging {
    param($RetainedDir, $CandidateArtifactDir)
    if ($Mode -eq 'verification-failure') { throw 'Synthetic candidate verification failure.' }
    $script:Events += 'staging'
}

function Download-VerifiedBaseline {
    param($Destination)
    $script:Events += 'download-baseline'
}

function Initialize-PreseededSettings {
    param($UserDataDir)
    $script:Events += 'settings'
}

function Initialize-SyntheticSentinels {
    param($UserDataDir, $CacheRoot)
    $script:Events += 'sentinels'
}

function Invoke-Installer {
    param($Installer, $InstallDir)
    $script:InstallDirs += $InstallDir
    $script:InstallerPaths += $Installer
    $script:Installed = if ($Installer -like '*alpha.8*') { $script:CandidateVersion } else { $script:BaselineVersion }
    $script:Events += "install:$script:Installed"
}

function Assert-Installed {
    param($Version)
    if ($script:Installed -ne $Version) { throw "Synthetic installed version mismatch: expected $Version, got $script:Installed" }
}

function Observe-RetainedHistoryLaunch {
    param($Phase, $InstallDir, $UserDataDir, $ExpectationsPath)
    if ($Mode -eq $Phase) { throw "Synthetic failure during observation phase $Phase." }
    $script:Events += "observe:$Phase"
    return @{ phase = $Phase; status = 'passed'; observations = @{ phase = $Phase }; closeRequested = $true }
}

function Invoke-HistoryDatabaseSeed {
    param($DbPath)
    $script:Events += 'seed'
    return @{
        seededRowCount = 3
        seededIds = @('fixture-hist-001', 'fixture-hist-002-delete', 'fixture-hist-003')
        records = @(
            @{ id = 'fixture-hist-003'; timestamp = 1729000003000; textHash = 'hash3' },
            @{ id = 'fixture-hist-002-delete'; timestamp = 1729000002000; textHash = 'hash2' },
            @{ id = 'fixture-hist-001'; timestamp = 1729000001000; textHash = 'hash1' }
        )
        status = 'success'
    }
}

function Uninstall-Current {
    param($Version)
    $script:Events += "uninstall:$Version"
    $script:Installed = ''
}

function Assert-CandidateBinding {
    param($CandidateInstaller, $CandidatePayload, $RetainedDir, $CandidateVersion, $RepoRoot)
    $script:Events += 'binding'
}

function Stop-OwnedHistoryProcess {
    if ($Mode -eq 'cleanup-failure') { throw 'Synthetic cleanup failure.' }
    $script:Stopped = $true
}

function Write-FunctionalHistoryEvidence {
    param($EvidenceData)
    $EvidenceData | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8
}

$failure = $null
$failureRecord = $null
try {
    Invoke-Expression $sequence[0].Extent.Text
} catch {
    $failureRecord = $_
    $failure = $_.Exception.Message
}

$evidence = if (Test-Path -LiteralPath $evidencePath) {
    Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json -AsHashtable
} else { $null }

if ($Mode -eq 'success') {
    if ($failure) { throw "Expected success but got failure: $failure" }
    if (-not $script:Stopped) { throw 'Cleanup was not called in finally block.' }
    if ($script:InstallDirs.Count -ne 3 -or @($script:InstallDirs | Where-Object { $_ -cne $script:InstallDir }).Count) {
        throw 'Every installation must target the owned install directory.'
    }
    $expectedCandidate = Join-Path $script:CandidateArtifactDir "Eve.Web.Setup.$script:CandidateVersion.exe"
    if ($script:InstallerPaths[1] -cne $expectedCandidate) {
        throw 'The candidate installation must use the staged candidate artifact.'
    }
    if ($null -eq $evidence) { throw 'Evidence file was not created.' }
    if ($evidence.overallStatus -ne 'passed') { throw "Expected overallStatus 'passed', got '$($evidence.overallStatus)'" }
    if (-not $script:FunctionalHistoryComplete) { throw 'Lifecycle did not complete successfully.' }
} else {
    if (-not $failure) { throw "Expected mode '$Mode' to fail, but it succeeded." }
    if ($Mode -eq 'verification-failure' -and ($script:InstallDirs.Count -ne 0 -or $script:InstallerPaths.Count -ne 0)) {
        throw 'Candidate verification failure must precede every installer invocation.'
    }
    if ($null -eq $evidence) { throw 'Evidence file was not created on failure.' }
    if ($evidence.overallStatus -ne 'failed') { throw "Expected overallStatus 'failed' for mode '$Mode', got '$($evidence.overallStatus)'" }
}

Write-Output "SEQUENCE_PROOF=$Mode"
