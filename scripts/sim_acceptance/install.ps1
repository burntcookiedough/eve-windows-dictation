[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('\A[1-9][0-9]*\z')][string]$RunId,
    [Parameter(Mandatory)][ValidatePattern('\A[1-9][0-9]*\z')][string]$ArtifactId,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-fA-F]{40}\z')][string]$Commit,
    [Parameter(Mandatory)][ValidatePattern('\A[0-9a-fA-F]{64}\z')][string]$ManifestSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_EVENT_NAME -notin @('workflow_dispatch', 'pull_request') -or
    $env:GITHUB_REPOSITORY -cne 'burntcookiedough/eve-windows-dictation' -or !$env:RUNNER_TEMP) {
    throw 'Simulated acceptance requires the repository''s disposable GitHub-hosted Windows runner.'
}
if ($env:GITHUB_EVENT_NAME -eq 'pull_request') {
    $event = Get-Content -LiteralPath $env:GITHUB_EVENT_PATH -Raw | ConvertFrom-Json
    if ($event.pull_request.head.repo.full_name -cne $env:GITHUB_REPOSITORY -or $event.pull_request.base.ref -cne 'trunk') {
        throw 'Only pull requests from the same repository to trunk may run packaged trials.'
    }
}
if ($env:GITHUB_RUN_ID -notmatch '^[1-9][0-9]*$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^[1-9][0-9]*$') {
    throw 'A unique hosted run and attempt are required.'
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$script:RepoRoot = $repo
. (Join-Path $repo 'scripts/retained-history-ci.ps1')
Assert-ExpectedCommit -Commit $env:GITHUB_SHA -RepoRoot $repo
$root = Join-Path $env:RUNNER_TEMP "eve-sim-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"
if (Test-Path -LiteralPath $root) { throw 'Hosted scratch directory already exists.' }
New-Item -ItemType Directory -Path $root | Out-Null
$bundle = Join-Path $root 'candidate'
$pins = @{
    RetainedDir = $bundle
    Source = 'retained'
    CandidateId = $ArtifactId
    CandidateCommit = $Commit.ToLowerInvariant()
    CandidateTag = 'v0.9.0-beta.1'
    ExpectedManifestSha256 = $ManifestSha256.ToLowerInvariant()
}
$candidate = Save-RetainedHistoryCandidate @pins
$env:GH_TOKEN = $null
if ($candidate.RunId -cne $RunId) { throw 'The retained artifact does not belong to the requested run.' }

$install = Join-Path $root 'install'
$stage = Join-Path $root 'verified-stage'
New-Item -ItemType Directory -Path $stage | Out-Null
function Write-Step { param([string]$Message) Write-Host $Message }
Assert-RetainedCandidateStaging -RetainedDir $bundle -CandidateArtifactDir $stage -Candidate $candidate -Stage
$wrapper = Join-Path $stage 'Eve.Web.Setup.0.9.0-beta.1.exe'

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\0204d005-75b3-5b31-b1f6-ef2831e2b204'
if (Test-Path -LiteralPath $uninstallKey) { throw 'Eve is already installed on the runner.' }
$installer = Start-Process -FilePath $wrapper -ArgumentList @('/S', "/D=$install") -WorkingDirectory $stage -WindowStyle Hidden -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "Verified installer exit code $($installer.ExitCode)." }
Assert-InstalledPayload -InstallDir $install -ManifestPath (Join-Path $bundle 'qa/candidate-payload-manifest.json')
$identity = @{
    run_id = $candidate.RunId
    artifact_id = $candidate.ArtifactId
    commit = $candidate.CandidateCommit
    manifest_sha256 = $candidate.ManifestSha256
} | ConvertTo-Json -Compress
"root=$root" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
"install=$install" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
"identity=$identity" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
