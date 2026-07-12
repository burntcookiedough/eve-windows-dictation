[CmdletBinding()]
param(
    [string]$ServerDir = (Join-Path $PSScriptRoot "..\server"),
    [string]$PythonVersion = "3.11"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$serverPath = (Resolve-Path $ServerDir).Path
$runtimePath = Join-Path $serverPath ".runtime"

uv python install $PythonVersion
$pythonPath = (& uv python find --managed-python $PythonVersion).Trim()
if (-not $pythonPath -or -not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "uv did not return a managed Python executable for $PythonVersion."
}

$runtimeSource = Split-Path -Parent $pythonPath
if (Test-Path -LiteralPath $runtimePath) {
    Remove-Item -LiteralPath $runtimePath -Recurse -Force
}

New-Item -ItemType Directory -Path $runtimePath | Out-Null
Copy-Item -Path (Join-Path $runtimeSource "*") -Destination $runtimePath -Recurse -Force

$bundledPython = Join-Path $runtimePath "python.exe"
if (-not (Test-Path -LiteralPath $bundledPython -PathType Leaf)) {
    throw "Relocatable runtime is missing python.exe after copy: $bundledPython"
}

Write-Host "Prepared relocatable Python runtime at $runtimePath"
