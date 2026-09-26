[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot ".."),
    [string]$ArtifactDir,
    [string]$InstalledDir,
    [string]$ModelCacheDir,
    [int]$Top = 20,
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Top -lt 1) { throw "Top must be positive." }
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$server = Join-Path $root "server"
$app = Join-Path $root "app"

function Measure-Tree {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $null }
    $files = @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force)
    $bytes = [long](($files | Measure-Object -Property Length -Sum).Sum)
    return [pscustomobject]@{ path = $Path; files = $files.Count; bytes = $bytes }
}

$sitePackages = Join-Path $server ".venv\Lib\site-packages"
$categories = @(
    [pscustomobject]@{ name = "Python packages"; path = $sitePackages }
    [pscustomobject]@{ name = "Standalone Python"; path = (Join-Path $server ".runtime") }
    [pscustomobject]@{ name = "Built app"; path = (Join-Path $app "dist") }
    [pscustomobject]@{ name = "App resources"; path = (Join-Path $app "resources") }
)

$totals = foreach ($category in $categories) {
    $size = Measure-Tree $category.path
    [pscustomobject]@{
        name = $category.name
        present = $null -ne $size
        bytes = if ($size) { $size.bytes } else { $null }
        files = if ($size) { $size.files } else { $null }
    }
}

$packages = @()
if (Test-Path -LiteralPath $sitePackages -PathType Container) {
    $packages = @(Get-ChildItem -LiteralPath $sitePackages -Force | ForEach-Object {
        $bytes = if ($_.PSIsContainer) {
            [long]((Get-ChildItem -LiteralPath $_.FullName -File -Recurse -Force |
                Measure-Object -Property Length -Sum).Sum)
        } else {
            [long]$_.Length
        }
        [pscustomobject]@{ name = $_.Name; bytes = $bytes }
    } | Sort-Object bytes -Descending | Select-Object -First $Top)
}

$releaseDir = if ($ArtifactDir) { (Resolve-Path -LiteralPath $ArtifactDir).Path } else { Join-Path $app "release" }
$artifacts = @()
if (Test-Path -LiteralPath $releaseDir -PathType Container) {
    $artifacts = @(Get-ChildItem -LiteralPath $releaseDir -File -Recurse |
        Where-Object { $_.Extension -in @(".7z", ".exe") } |
        ForEach-Object { [pscustomobject]@{ name = $_.Name; bytes = [long]$_.Length } } |
        Sort-Object bytes -Descending)
}
if ($ArtifactDir -and $artifacts.Count -eq 0) {
    throw "No .7z or .exe installer artifacts found in $releaseDir"
}

$result = [pscustomobject]@{
    repository = $root
    totals = @($totals)
    largestSitePackages = $packages
    installerArtifacts = $artifacts
    installed = if ($InstalledDir) { Measure-Tree ((Resolve-Path -LiteralPath $InstalledDir).Path) } else { $null }
    modelCache = if ($ModelCacheDir) { Measure-Tree ((Resolve-Path -LiteralPath $ModelCacheDir).Path) } else { $null }
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 5
} else {
    $totals | Format-Table name, present, bytes, files -AutoSize
    if ($packages.Count) {
        "Largest site-packages entries:"
        $packages | Format-Table name, bytes -AutoSize
    }
    if ($artifacts.Count) {
        "Installer artifacts:"
        $artifacts | Format-Table name, bytes -AutoSize
    }
    if ($result.installed) { "Installed directory: $($result.installed.bytes) bytes ($($result.installed.files) files)" }
    if ($result.modelCache) { "Explicit model cache: $($result.modelCache.bytes) bytes ($($result.modelCache.files) files)" }
}
