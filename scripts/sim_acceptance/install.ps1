[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('45784796424')][string]$RunId,
    [Parameter(Mandatory)][ValidateSet('15101085356')][string]$ArtifactId,
    [Parameter(Mandatory)][ValidatePattern('(?-i)^22aa01d70a10fc8b52668866ff1c0bd5ac02c751$')][string]$Commit,
    [Parameter(Mandatory)][ValidatePattern('(?-i)^e0004b05ee119467a037c201ea723159e01adda3615f5a2668cfb05433fe763f$')][string]$ManifestSha256
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
    CandidateCommit = $Commit
    CandidateTag = 'v0.9.0-beta.1'
    ExpectedManifestSha256 = $ManifestSha256
}
$candidate = Save-RetainedHistoryCandidate @pins
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
"root=$root" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
"install=$install" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
