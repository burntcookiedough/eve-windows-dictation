param([string]$SmokeScript, [string]$PythonExe, [string]$BackendScript,
      [string]$Root, [string]$Mode)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($SmokeScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Smoke source did not parse' }
foreach ($function in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $function.Extent.Text
}

if ($Mode -eq 'provider-paths') {
    $self = Get-Process -Id $PID
    try {
        $image = $self.Path
        $staleDirectory = Join-Path $Root 'different native directory'
        New-Item -ItemType Directory -Path $staleDirectory | Out-Null
        [Environment]::CurrentDirectory = $staleDirectory
        Set-Location -LiteralPath (Split-Path -Parent $image)
        $identity = Get-SmokeProcessIdentity -Process $self -ExpectedPath ('.\' + [IO.Path]::GetFileName($image))
        if ($identity.Path -ine $image) { throw 'Relative launch identity resolved outside the PowerShell location' }
        Set-Location -LiteralPath $Root
        $paths = @(Get-SmokeTargetPaths -Directories @('installed'))
        if ((Join-Path $Root 'installed/Eve.exe') -notin $paths) { throw 'Target paths ignored PowerShell location' }
        Write-Output 'PROVIDER_PROOF=relative target/image paths follow PowerShell location'
    } finally { $self.Dispose() }
    exit 0
}

if ($Mode -eq 'preflight') {
    $script:Stops = 0
    $script:CandidatePath = Join-Path $Root 'unrelated/Eve.exe'
    function Get-Process { [pscustomobject]@{ Id = 123; Path = $script:CandidatePath } }
    function Stop-Process { param([Parameter(ValueFromPipeline)]$InputObject, [switch]$Force) process { $script:Stops++ } }
    function Get-CimInstance { [pscustomobject]@{ ProcessId = 123; ExecutablePath = $script:CandidatePath } }
    $target = Join-Path $Root 'installed'
    if (Get-Command Assert-SmokeTargetsIdle -ErrorAction SilentlyContinue) {
        Assert-SmokeTargetsIdle -Directories @($target)
        $script:CandidatePath = Join-Path $target 'Eve.exe'
        $refused = $false
        try { Assert-SmokeTargetsIdle -Directories @($target) } catch { $refused = $true }
        if (-not $refused) { throw 'Preflight accepted a running target' }
        $script:CandidatePath = $null
        $refused = $false
        try { Assert-SmokeTargetsIdle -Directories @($target) } catch { $refused = $true }
        if (-not $refused) { throw 'Preflight accepted an inaccessible process path' }
    } else { Stop-ProductProcesses }
    if ($script:Stops) { throw 'Preflight stopped an unrelated Eve process' }
    Write-Output 'PREFLIGHT_PROOF=foreign untouched; target refused'
    exit 0
}

function Wait-ProbeRecord([string]$Directory) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $file = Join-Path $Directory 'ready.json'
        if (Test-Path -LiteralPath $file) { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
        Start-Sleep -Milliseconds 25
    }
    throw 'Disposable backend did not start'
}
$launcherFile = Join-Path $Root 'launcher.ps1'
@'
param([string]$PythonExe, [string]$BackendScript, [string]$ChildRoot, [switch]$Nested, [switch]$ExitEarly)
$childArguments = @('-u', "`"$BackendScript`"", "`"$ChildRoot`"")
if ($Nested) { $childArguments += 'relay' }
$child = Start-Process -FilePath $PythonExe -ArgumentList $childArguments -PassThru -WindowStyle Hidden
if ($ExitEarly) {
    New-Item -ItemType Directory -Path $ChildRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $ChildRoot 'launcher-done.txt') -Value 'exiting'
    exit 0
}
Start-Sleep -Seconds 20
Set-Content -LiteralPath (Join-Path $ChildRoot 'launcher-expired.txt') -Value 'fixture TTL expired'
'@ | Set-Content -LiteralPath $launcherFile
$ownRoot = Join-Path $Root 'owned'
$foreignRoot = Join-Path $Root 'unrelated'
$process = $null; $backend = $null; $foreign = $null; $launcherObserver = $null
$leaf = $null
$ownedLauncher = $null
try {
    $shellExe = (Get-Process -Id $PID).Path
    $launcherArguments = @('-NoProfile', '-File', "`"$launcherFile`"", '-PythonExe', "`"$PythonExe`"", '-BackendScript', "`"$BackendScript`"", '-ChildRoot', "`"$ownRoot`"")
    if ($Mode -eq 'nested') { $launcherArguments += '-Nested' }
    if ($Mode -eq 'fast-launcher') { $launcherArguments += '-ExitEarly' }
    $process = Start-Process -FilePath $shellExe -ArgumentList $launcherArguments -PassThru -WindowStyle Hidden
    if ($Mode -eq 'fast-launcher') {
        $record = Wait-ProbeRecord $ownRoot
        $backend = Get-Process -Id $record.pid
        $null = $backend.SafeHandle
        # Do not acquire a second observer handle or inspect the launcher module.
        # Delay capture until the launcher has exited, as an immediate crash can.
        Start-Sleep -Milliseconds 150
    }
    $sourceHandle = $process.SafeHandle
    if ($Mode -ne 'fast-launcher') {
        $launcherObserver = Get-Process -Id $process.Id
        $null = $launcherObserver.SafeHandle
    }
    if (Get-Command Get-SmokeProcessIdentity -ErrorAction SilentlyContinue) {
        $ownedLauncher = Get-SmokeProcessIdentity -Process $process -ExpectedPath $shellExe
    }
    if ($Mode -eq 'fast-launcher' -and -not $process.HasExited) { throw 'Fixture did not exit before identity capture' }
    $record = Wait-ProbeRecord $ownRoot
    if ($record.parent -ne $process.Id) { throw 'Fixture child was not spawned by the owned launcher' }
    if (-not $backend) { $backend = Get-Process -Id $record.pid; $null = $backend.SafeHandle }
    if ($Mode -eq 'nested') {
        $leafRecord = Wait-ProbeRecord (Join-Path $ownRoot 'leaf')
        if ($leafRecord.parent -ne $backend.Id) { throw 'Fixture relay did not own its child' }
        $leaf = Get-Process -Id $leafRecord.pid
        $null = $leaf.SafeHandle
    }
    $foreign = Start-Process -FilePath $PythonExe -ArgumentList @('-u', "`"$BackendScript`"", "`"$foreignRoot`"") -PassThru -WindowStyle Hidden
    $null = $foreign.SafeHandle
    $foreignRecord = Wait-ProbeRecord $foreignRoot
    if ($foreignRecord.pid -ne $foreign.Id) { throw 'Unexpected foreign fixture identity' }
    $held = Join-Path $ownRoot 'held.txt'
    $locked = $false
    try { $stream = [IO.File]::Open($held, 'Open', 'ReadWrite', 'None'); $stream.Dispose() } catch [IO.IOException] { $locked = $true }
    if (-not $locked) { throw 'Fixture file was not held before cleanup' }
    $allowedSmokePaths = @($shellExe, $PythonExe)
    if ($Mode -eq 'wrong-path') { $allowedSmokePaths = @($shellExe) }
    if ($Mode -in @('wrong-parent', 'wrong-birth', 'exit-during-inspection')) {
        $script:BackendId = $backend.Id
        $script:ForeignId = $foreign.Id
        $script:BackendProcess = $backend
        function Get-CimInstance {
            [CmdletBinding()]param([string]$ClassName, [string]$Filter)
            $rows = @(CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter $Filter -ErrorAction Stop)
            if ($Mode -eq 'wrong-birth' -and $Filter -like 'ParentProcessId = *') {
                return @($rows | ForEach-Object {
                    if ($_.ProcessId -eq $script:BackendId) {
                        [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; ExecutablePath=$_.ExecutablePath; CreationDate=$_.CreationDate.AddSeconds(-1) }
                    } else { $_ }
                })
            }
            if ($Filter -eq "ProcessId = $script:BackendId") {
                if ($Mode -eq 'exit-during-inspection') {
                    $script:BackendProcess.Kill()
                    $null = $script:BackendProcess.WaitForExit(5000)
                    return $null
                }
                return [pscustomobject]@{ ParentProcessId = $script:ForeignId }
            }
            return $rows
        }
    }
    if ($Mode -eq 'exit-on-parent-stop') {
        $script:BackendProcess = $backend
        $script:LauncherProcess = $process
        function Get-Process {
            [CmdletBinding()]param([int]$Id)
            if ($Id -eq $script:BackendProcess.Id -and $script:LauncherProcess.HasExited) {
                if (-not $script:BackendProcess.HasExited) { $script:BackendProcess.Kill(); $null = $script:BackendProcess.WaitForExit(5000) }
                throw 'Child exited between the post-stop snapshot and handle capture'
            }
            Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
        }
    }
    if ($Mode -eq 'second-scan-failure') {
        $script:LauncherId = $process.Id
        $script:RootScans = 0
        function Get-CimInstance {
            [CmdletBinding()]param([string]$ClassName, [string]$Filter)
            if ($Filter -eq "ParentProcessId = $script:LauncherId") {
                $script:RootScans++
                if ($script:RootScans -eq 2) { throw 'synthetic second scan failure' }
            }
            CimCmdlets\Get-CimInstance -ClassName $ClassName -Filter $Filter -ErrorAction Stop
        }
    }
    # A fresh, same-executable foreign PID must not become cleanup authority.
    $pidData = @{ pid = $foreign.Id; port = $foreignRecord.port; startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    if ($Mode -eq 'missing-pid') { $pidData = $null }
    if ($Mode -eq 'forced') {
        $process.Kill(); $null = $process.WaitForExit(5000)
        $orphan = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($backend.Id)"
        if ($orphan.ParentProcessId -ne $process.Id) { throw 'Live child did not retain the exited launcher parent ID' }
    }
    $cleanup = @($ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] -and $_.Finally })[-1].Finally
    $primaryFailure = $false
    $cleanupError = $null
    try {
        try { if ($Mode -eq 'failure') { throw 'synthetic health failure' } }
        catch { $primaryFailure = $true }
        finally { Invoke-Expression ($cleanup.Statements.Extent.Text -join "`n") }
    } catch { $cleanupError = $_ }
    if (-not $sourceHandle.IsClosed) { throw 'Smoke cleanup did not release its launcher handle' }
    if ($Mode -in @('wrong-path', 'wrong-parent', 'wrong-birth')) {
        if (-not $cleanupError -or $cleanupError.Exception.Message -notmatch 'cleanup could not be verified') { throw 'Cleanup did not report ownership refusal' }
        if ($backend.HasExited -or $foreign.HasExited) { throw 'Cleanup stopped a process after failed identity validation' }
        Write-Output "REFUSAL_PROOF=$Mode; no unsafe stop; incomplete cleanup reported"
        return
    }
    if ($Mode -eq 'second-scan-failure') {
        if (-not $cleanupError -or $cleanupError.Exception.Message -notmatch 'synthetic second scan failure') { throw 'Cleanup did not report the failed scan' }
        $cleanupError = $null # Expected failure; still require real child/port/file cleanup below.
    }
    if ($cleanupError) { throw $cleanupError }
    if ((Test-Path -LiteralPath (Join-Path $ownRoot 'expired.txt')) -or
        (Test-Path -LiteralPath (Join-Path $ownRoot 'launcher-expired.txt'))) { throw 'Fixture expired naturally; not cleanup proof' }
    if ($Mode -eq 'failure' -and -not $primaryFailure) { throw 'Fixture missed failure path' }
    if ($launcherObserver -and -not $launcherObserver.WaitForExit(5000)) { throw 'Owned launcher survived cleanup' }
    if (-not $backend.WaitForExit(1000)) { throw 'Owned backend survived actual smoke cleanup' }
    if ($leaf) {
        if (Test-Path -LiteralPath (Join-Path $ownRoot 'leaf/expired.txt')) { throw 'Grandchild expired naturally; not cleanup proof' }
        if (-not $leaf.WaitForExit(1000)) { throw 'Owned grandchild survived cleanup' }
        $leafHeld = Join-Path $ownRoot 'leaf/held.txt'
        $stream = [IO.File]::Open($leafHeld, 'Open', 'ReadWrite', 'None'); $stream.Dispose()
        Remove-Item -LiteralPath $leafHeld
        $leafListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$leafRecord.port)
        try { $leafListener.Start() } finally { $leafListener.Stop() }
    }
    if ($foreign.HasExited) { throw 'Unrelated same-executable Python was stopped' }
    $stream = [IO.File]::Open($held, 'Open', 'ReadWrite', 'None'); $stream.Dispose()
    Remove-Item -LiteralPath $held
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$record.port)
    try { $listener.Start() } finally { $listener.Stop() }
    Write-Output "CLEANUP_PROOF=$Mode; backend exited; port/file released; unrelated Python alive"
} finally {
    foreach ($fixture in @($leaf, $backend, $foreign, $launcherObserver)) {
        if ($fixture) {
            try { if (-not $fixture.HasExited) { $fixture.Kill(); $null = $fixture.WaitForExit(5000) } }
            finally { $fixture.Dispose() }
        }
    }
    if ($process -and $Mode -eq 'fast-launcher') { $process.Dispose() }
}
