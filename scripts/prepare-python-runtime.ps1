[CmdletBinding()]
param(
    [string]$ServerDir = (Join-Path $PSScriptRoot "..\server"),
    [string]$PythonVersion = "3.11"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$serverPath = (Resolve-Path $ServerDir).Path
$runtimePath = Join-Path $serverPath ".runtime"

function Test-PathWithin {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    return $resolvedPath.StartsWith("$resolvedRoot$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedPath.Equals($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SelfContainedRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RuntimePath
    )

    $bundledPython = Join-Path $RuntimePath "python.exe"
    $probeScript = 'import json, sys; print(json.dumps({"prefix": sys.prefix, "base_prefix": sys.base_prefix, "executable": sys.executable, "path": sys.path}))'
    $probe = & $bundledPython -I -c $probeScript
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled Python isolation probe failed with exit code $LASTEXITCODE."
    }

    $runtimeProbe = $probe | ConvertFrom-Json
    foreach ($property in @("prefix", "base_prefix", "executable")) {
        $value = [string]$runtimeProbe.$property
        if (-not (Test-PathWithin -Path $value -Root $RuntimePath)) {
            throw "Bundled Python $property resolves outside the runtime: $value"
        }
    }

    foreach ($entry in @($runtimeProbe.path)) {
        $value = [string]$entry
        if (-not [System.IO.Path]::IsPathRooted($value) -or -not (Test-PathWithin -Path $value -Root $RuntimePath)) {
            throw "Bundled Python sys.path entry resolves outside the runtime: $value"
        }
    }
}

function Get-PythonAbi {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PythonPath
    )

    $pythonAbi = (& $PythonPath -I -c 'import sys; print(f"{sys.version_info.major}{sys.version_info.minor}")').Trim()
    if ($LASTEXITCODE -ne 0 -or $pythonAbi -notmatch '^\d+$') {
        throw "Could not determine the Python ABI for $PythonPath."
    }
    return $pythonAbi
}

uv python install $PythonVersion
$previousVirtualEnv = $env:VIRTUAL_ENV
try {
    Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
    Push-Location $PSScriptRoot
    try {
        $pythonPath = (& uv python find --managed-python --no-project --resolve-links $PythonVersion).Trim()
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $previousVirtualEnv) {
        Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
    } else {
        $env:VIRTUAL_ENV = $previousVirtualEnv
    }
}

if (-not $pythonPath -or -not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw "uv did not return a managed Python executable for $PythonVersion."
}

$pythonPath = [System.IO.Path]::GetFullPath($pythonPath)
if ((Test-PathWithin -Path $pythonPath -Root $serverPath) -or
    $pythonPath -match '(?i)(^|[\\/])\.venv([\\/]|$)' -or
    (Split-Path -Parent $pythonPath) -match '(?i)(^|[\\/])Scripts$') {
    throw "uv returned a project or virtual-environment interpreter instead of a standalone managed Python: $pythonPath"
}

$runtimeSource = Split-Path -Parent $pythonPath
$pythonAbi = Get-PythonAbi -PythonPath $pythonPath

$venvPython = Join-Path $serverPath ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw "Release virtual environment is missing its Python executable: $venvPython"
}
$venvAbi = Get-PythonAbi -PythonPath $venvPython
if ($venvAbi -ne $pythonAbi) {
    throw "Release .venv/runtime Python ABI mismatch: .venv=$venvAbi runtime=$pythonAbi"
}

foreach ($required in @("python.exe", "python$pythonAbi.dll", "Lib", "DLLs")) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeSource $required))) {
        throw "Managed Python root is incomplete; missing $required at $runtimeSource"
    }
}

if (Test-Path -LiteralPath $runtimePath) {
    Remove-Item -LiteralPath $runtimePath -Recurse -Force
}

New-Item -ItemType Directory -Path $runtimePath | Out-Null
Copy-Item -Path (Join-Path $runtimeSource "*") -Destination $runtimePath -Recurse -Force

Assert-SelfContainedRuntime -RuntimePath $runtimePath

Write-Host "Prepared relocatable Python runtime at $runtimePath"
