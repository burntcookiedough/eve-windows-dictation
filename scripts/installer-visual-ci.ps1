[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Initialize', 'Capture', 'Cleanup')]
    [string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ProductVersion = '0.8.2-alpha.6'
$script:ProductGuid = '0204d005-75b3-5b31-b1f6-ef2831e2b204'
$script:CandidateRef = 'refs/heads/codex/eve-alpha6-candidate'
$script:RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Get-RunRoot {
    if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -or [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID) -or [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT)) {
        throw 'GitHub runner temp path and run identity are required.'
    }
    return [System.IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP "eve-alpha6-installer-visual-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT"))
}

function Test-PathWithin {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-CiContext {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OS -ne 'Windows_NT') {
        throw 'This installer visual probe runs only on a disposable GitHub-hosted Windows runner.'
    }
    if ($env:GITHUB_EVENT_NAME -ne 'pull_request' -or $env:GITHUB_REPOSITORY -ne 'burntcookiedough/eve-windows-dictation' -or $env:EVE_VISUAL_PR_NUMBER -ne '89' -or
        $env:EVE_VISUAL_PR_HEAD_REPOSITORY -ne $env:GITHUB_REPOSITORY -or $env:GITHUB_HEAD_REF -ne 'codex/eve-alpha6-candidate' -or $env:GITHUB_BASE_REF -ne 'trunk') {
        throw 'Only PR 89 from the same-repo candidate branch into trunk may run the installer visual probe.'
    }
    if ($env:EVE_VISUAL_CANDIDATE_SHA -notmatch '^[0-9a-f]{40}$') { throw 'Candidate PR head SHA is missing or malformed.' }
    $root = Get-RunRoot
    if (-not (Test-PathWithin -Path $root -Root $env:RUNNER_TEMP)) { throw 'Visual probe scratch directory escaped RUNNER_TEMP.' }
    if ($root -match '\s') { throw 'RUNNER_TEMP path contains whitespace; NSIS /D requires an unquoted final argument.' }
}

function Assert-CandidateHead {
    $head = ([string](& git -C $script:RepoRoot rev-parse HEAD)).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $env:EVE_VISUAL_CANDIDATE_SHA) { throw 'Candidate checkout does not match the PR head SHA.' }
    $remoteLine = & git -C $script:RepoRoot ls-remote origin $script:CandidateRef
    if ($LASTEXITCODE -ne 0 -or [string]$remoteLine -notmatch '^([0-9a-f]{40})\s+refs/heads/codex/eve-alpha6-candidate$' -or $Matches[1] -ne $head) {
        throw 'Candidate checkout is not the current candidate branch head.'
    }
    return $head
}

function Get-EvidencePath {
    return Join-Path (Join-Path (Get-RunRoot) 'evidence') 'result.json'
}

function Save-State {
    param([Parameter(Mandatory)]$State)
    $State | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Get-EvidencePath) -Encoding utf8
}

function Add-Diagnostic {
    param([Parameter(Mandatory)]$State, [Parameter(Mandatory)][string]$Code, [Parameter(Mandatory)][string]$Message)
    $State.diagnostics = @($State.diagnostics) + @([pscustomobject]@{ atUtc = [DateTime]::UtcNow.ToString('o'); code = $Code; message = $Message })
}

function Resolve-VisualUninstallerPath {
    param([Parameter(Mandatory)]$Entry, [Parameter(Mandatory)][string]$InstallDir)
    $expectedInstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd([char[]]@('\', '/'))
    $expectedUninstaller = [System.IO.Path]::GetFullPath((Join-Path $expectedInstallDir 'Uninstall Eve.exe'))
    $displayName = if ($Entry.PSObject.Properties['DisplayName']) { [string]$Entry.PSObject.Properties['DisplayName'].Value } else { '' }
    $displayVersion = if ($Entry.PSObject.Properties['DisplayVersion']) { [string]$Entry.PSObject.Properties['DisplayVersion'].Value } else { '' }
    $uninstallString = if ($Entry.PSObject.Properties['UninstallString']) { [string]$Entry.PSObject.Properties['UninstallString'].Value } else { '' }
    $installLocation = if ($Entry.PSObject.Properties['InstallLocation']) { [string]$Entry.PSObject.Properties['InstallLocation'].Value } else { '' }
    if ($displayName -ne "Eve $script:ProductVersion" -or $displayVersion -ne $script:ProductVersion) {
        throw 'Eve registry entry does not match the expected alpha.6 display identity.'
    }
    if ($uninstallString -notmatch '^\s*"(?<path>[^"\r\n]+\\Uninstall Eve\.exe)"\s+/currentuser\s*$') {
        throw 'Eve registry entry lacks the expected quoted per-user NSIS uninstall command.'
    }
    $uninstallerPath = [System.IO.Path]::GetFullPath($Matches['path'])
    if (-not $uninstallerPath.Equals($expectedUninstaller, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Eve registry uninstall command points outside the isolated install directory.'
    }
    if ($installLocation -and -not [System.IO.Path]::GetFullPath($installLocation).TrimEnd([char[]]@('\', '/')).Equals($expectedInstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Eve registry InstallLocation points outside the isolated install directory.'
    }
    return $uninstallerPath
}

function Test-VisualUninstallerOwnershipRule {
    $installDir = Join-Path (Get-RunRoot) 'synthetic-owner-check\Programs\Eve'
    $uninstallerPath = Join-Path $installDir 'Uninstall Eve.exe'
    $entry = [pscustomobject]@{
        DisplayName = "Eve $script:ProductVersion"
        DisplayVersion = $script:ProductVersion
        UninstallString = '"' + $uninstallerPath + '" /currentuser'
        InstallLocation = ''
    }
    $resolved = Resolve-VisualUninstallerPath -Entry $entry -InstallDir $installDir
    if (-not $resolved.Equals([System.IO.Path]::GetFullPath($uninstallerPath), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Synthetic blank-InstallLocation ownership check resolved an unexpected path.'
    }
    $entry.UninstallString = '"' + (Join-Path (Get-RunRoot) 'outside\Uninstall Eve.exe') + '" /currentuser'
    $rejected = $false
    try { $null = Resolve-VisualUninstallerPath -Entry $entry -InstallDir $installDir } catch { $rejected = $true }
    if (-not $rejected) { throw 'Synthetic external-uninstaller ownership check was not rejected.' }
    $entry.UninstallString = '"' + $uninstallerPath + '" /currentuser'
    $entry.InstallLocation = Join-Path (Get-RunRoot) 'outside'
    $rejected = $false
    try { $null = Resolve-VisualUninstallerPath -Entry $entry -InstallDir $installDir } catch { $rejected = $true }
    if (-not $rejected) { throw 'Synthetic external-InstallLocation check was not rejected.' }
}

function Get-DesktopShortcutExpected {
    param([Parameter(Mandatory)]$NsisOptions)
    $property = $NsisOptions.PSObject.Properties['createDesktopShortcut']
    $configuredValue = if ($property) { $property.Value } else { $null }
    return $configuredValue -ne $false
}

function Resolve-VisualBuildSettings {
    param([Parameter(Mandatory)]$Package)
    $buildProperty = $Package.PSObject.Properties['build']
    if (-not $buildProperty -or $null -eq $buildProperty.Value) { throw 'Visual package config is missing its nested build object.' }
    $build = $buildProperty.Value
    $winProperty = $build.PSObject.Properties['win']
    $nsisWebProperty = $build.PSObject.Properties['nsisWeb']
    if (-not $winProperty -or -not $nsisWebProperty) { throw 'Visual package config is missing build.win or build.nsisWeb.' }
    return [pscustomobject]@{ Win = $winProperty.Value; NsisWeb = $nsisWebProperty.Value }
}

function Test-VisualBuildSettingsRule {
    $expectedWin = [pscustomobject]@{ icon = 'resources/icon.ico' }
    $expectedNsisWeb = [pscustomobject]@{ oneClick = $true; createDesktopShortcut = $true }
    $package = [pscustomobject]@{
        build = [pscustomobject]@{ win = $expectedWin; nsisWeb = $expectedNsisWeb }
        win = [pscustomobject]@{ icon = 'wrong-top-level-icon.ico' }
        nsisWeb = [pscustomobject]@{ oneClick = $false; createDesktopShortcut = $false }
    }
    $settings = Resolve-VisualBuildSettings -Package $package
    if ($settings.Win.icon -ne $expectedWin.icon -or -not $settings.NsisWeb.oneClick -or -not (Get-DesktopShortcutExpected -NsisOptions $settings.NsisWeb)) {
        throw 'Synthetic test failed: visual settings must come from package.build.win and package.build.nsisWeb.'
    }
    $topLevelOnly = [pscustomobject]@{ win = $expectedWin; nsisWeb = $expectedNsisWeb }
    $rejected = $false
    try { $null = Resolve-VisualBuildSettings -Package $topLevelOnly } catch { $rejected = $_.Exception.Message -match 'nested build object' }
    if (-not $rejected) { throw 'Synthetic test failed: top-level-only installer settings were not rejected.' }
}

function Assert-DesktopShortcutEvidence {
    param([Parameter(Mandatory)][bool]$Exists, [Parameter(Mandatory)][bool]$Expected, [Parameter(Mandatory)][string]$Path)
    if ($Exists) { return 'present' }
    if ($Expected) { throw "DESKTOP_SHORTCUT_MISSING: fresh alpha.6 install did not create the expected Desktop Eve shortcut at '$Path'." }
    return 'not-created-as-configured'
}

function Test-DesktopShortcutEvidenceRules {
    $defaultOptions = [pscustomobject]@{}
    $disabledOptions = [pscustomobject]@{ createDesktopShortcut = $false }
    if (-not (Get-DesktopShortcutExpected -NsisOptions $defaultOptions)) { throw 'Synthetic test failed: omitted createDesktopShortcut must mean enabled on a fresh install.' }
    if (Get-DesktopShortcutExpected -NsisOptions $disabledOptions) { throw 'Synthetic test failed: createDesktopShortcut=false must disable the requirement.' }
    if ((Assert-DesktopShortcutEvidence -Exists $true -Expected $true -Path 'synthetic\Eve.lnk') -ne 'present') { throw 'Synthetic test failed: existing required Desktop shortcut was not accepted.' }
    if ((Assert-DesktopShortcutEvidence -Exists $false -Expected $false -Path 'synthetic\Eve.lnk') -ne 'not-created-as-configured') { throw 'Synthetic test failed: an explicitly disabled Desktop shortcut was not accepted.' }
    $rejected = $false
    try { $null = Assert-DesktopShortcutEvidence -Exists $false -Expected (Get-DesktopShortcutExpected -NsisOptions $defaultOptions) -Path 'synthetic\Eve.lnk' }
    catch { $rejected = $_.Exception.Message -match '^DESKTOP_SHORTCUT_MISSING:' }
    if (-not $rejected) { throw 'Synthetic test failed: a missing required Desktop shortcut was not rejected.' }
}

function Add-NativeDesktopType {
    if ('EveInstallerVisual.NativeDesktop' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace EveInstallerVisual {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public static class NativeDesktop {
        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError=true)] private static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
        public static int CheckInputDesktop() {
            const uint DESKTOP_READOBJECTS = 0x0001;
            IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
            if (desktop == IntPtr.Zero) return Marshal.GetLastWin32Error();
            CloseDesktop(desktop);
            return 0;
        }
    }
}
'@
}

function Get-ScreenBounds {
    Add-NativeDesktopType
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not [Environment]::UserInteractive) {
        throw 'INTERACTIVE_DESKTOP_UNAVAILABLE: runner process is not attached to an interactive Windows desktop.'
    }
    $activeSession = [EveInstallerVisual.NativeDesktop]::WTSGetActiveConsoleSessionId()
    $currentSession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($activeSession -eq [uint32]::MaxValue -or $currentSession -ne [int]$activeSession) {
        throw "INTERACTIVE_DESKTOP_UNAVAILABLE: runner session $currentSession is not the active console session."
    }
    $desktopError = [EveInstallerVisual.NativeDesktop]::CheckInputDesktop()
    if ($desktopError -ne 0) {
        throw "INTERACTIVE_DESKTOP_UNAVAILABLE: Windows did not expose the input desktop (Win32 error $desktopError)."
    }
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    if ($null -eq $screen -or $screen.Bounds.Width -lt 320 -or $screen.Bounds.Height -lt 240) {
        throw 'INTERACTIVE_DESKTOP_UNAVAILABLE: runner has no capturable primary display.'
    }
    return $screen.Bounds
}

function Save-Screenshot {
    param([Parameter(Mandatory)][System.Drawing.Rectangle]$Bounds, [Parameter(Mandatory)][string]$Path)
    try {
        $bitmap = [System.Drawing.Bitmap]::new($Bounds.Width, $Bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($Bounds.X, $Bounds.Y, 0, 0, $Bounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
            $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
        if ((Get-Item -LiteralPath $Path).Length -lt 1024) { throw 'Screenshot file is unexpectedly small.' }
    } catch {
        throw "INTERACTIVE_DESKTOP_UNAVAILABLE: screenshot capture failed: $($_.Exception.Message)"
    }
}

function New-SanitizedStartInfo {
    param([Parameter(Mandatory)][string]$FilePath, [Parameter(Mandatory)][string]$WorkingDirectory, [Parameter(Mandatory)][string[]]$Arguments)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    $startInfo.Environment.Clear()
    $source = [System.Environment]::GetEnvironmentVariables('Process')
    foreach ($name in @('SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS')) {
        $value = [string]$source[$name]
        if (-not [string]::IsNullOrWhiteSpace($value)) { $startInfo.Environment[$name] = $value }
    }
    $safeTemp = Join-Path (Get-RunRoot) 'temp'
    New-Item -ItemType Directory -Path $safeTemp -Force | Out-Null
    $startInfo.Environment['TEMP'] = $safeTemp
    $startInfo.Environment['TMP'] = $safeTemp
    if (@($startInfo.Environment.Keys | Where-Object { $_ -match '(?i)(TOKEN|SECRET|PASSWORD|CREDENTIAL|ACTIONS_RUNTIME|GITHUB_)' }).Count -ne 0) {
        throw 'Installer process environment unexpectedly includes a credential-like variable.'
    }
    foreach ($argument in $Arguments) { $startInfo.ArgumentList.Add($argument) }
    return $startInfo
}

function Get-VisibleWindow {
    param([Parameter(Mandatory)][System.Diagnostics.Process]$Process, [Parameter(Mandatory)][System.Drawing.Rectangle]$ScreenBounds)
    $Process.Refresh()
    $handle = $Process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero -or -not [EveInstallerVisual.NativeDesktop]::IsWindowVisible($handle)) { return $null }
    $rect = [EveInstallerVisual.RECT]::new()
    if (-not [EveInstallerVisual.NativeDesktop]::GetWindowRect($handle, [ref]$rect)) { return $null }
    $left = [Math]::Max($rect.Left, $ScreenBounds.Left)
    $top = [Math]::Max($rect.Top, $ScreenBounds.Top)
    $right = [Math]::Min($rect.Right, $ScreenBounds.Right)
    $bottom = [Math]::Min($rect.Bottom, $ScreenBounds.Bottom)
    if (($right - $left) -lt 120 -or ($bottom - $top) -lt 80) { return $null }
    return [pscustomobject]@{
        Handle = $handle
        Title = $Process.MainWindowTitle
        Bounds = [System.Drawing.Rectangle]::new($left, $top, $right - $left, $bottom - $top)
        OriginalBounds = [System.Drawing.Rectangle]::new($rect.Left, $rect.Top, $rect.Right - $rect.Left, $rect.Bottom - $rect.Top)
    }
}

function Capture-InstallerScreen {
    param([Parameter(Mandatory)]$Window, [Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)]$State)
    [void][EveInstallerVisual.NativeDesktop]::SetForegroundWindow($Window.Handle)
    Start-Sleep -Milliseconds 400
    $foreground = [EveInstallerVisual.NativeDesktop]::GetForegroundWindow()
    [uint32]$foregroundPid = 0
    [void][EveInstallerVisual.NativeDesktop]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    if ($foregroundPid -ne $ProcessId) {
        throw 'INTERACTIVE_DESKTOP_UNAVAILABLE: installer window could not be brought to the foreground.'
    }
    $path = Join-Path (Join-Path (Get-RunRoot) 'evidence') "installer-$Name.png"
    Save-Screenshot -Bounds $Window.Bounds -Path $path
    $State.screenshots = @($State.screenshots) + @([pscustomobject]@{
        file = [System.IO.Path]::GetFileName($path)
        windowTitle = [string]$Window.Title
        width = $Window.Bounds.Width
        height = $Window.Bounds.Height
        windowBounds = [pscustomobject]@{ x = $Window.OriginalBounds.X; y = $Window.OriginalBounds.Y; width = $Window.OriginalBounds.Width; height = $Window.OriginalBounds.Height }
        capturedBounds = [pscustomobject]@{ x = $Window.Bounds.X; y = $Window.Bounds.Y; width = $Window.Bounds.Width; height = $Window.Bounds.Height }
        atUtc = [DateTime]::UtcNow.ToString('o')
    })
    Save-State -State $State
}

function Save-ShortcutIcon {
    param([Parameter(Mandatory)][string]$LinkPath, [Parameter(Mandatory)][string]$Kind, [Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)]$State, [bool]$ExpectedByPackageConfig = $true)
    $expectedExe = [System.IO.Path]::GetFullPath((Join-Path $InstallDir 'Eve.exe'))
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($LinkPath)
    $target = [System.IO.Path]::GetFullPath([string]$shortcut.TargetPath)
    if (-not $target.Equals($expectedExe, [System.StringComparison]::OrdinalIgnoreCase)) { throw "$Kind shortcut does not target the isolated Eve.exe." }
    $iconPath = ([string]$shortcut.IconLocation -replace ',\s*-?\d+$', '').Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($iconPath) -or -not (Test-Path -LiteralPath $iconPath -PathType Leaf) -or -not (Test-PathWithin -Path $iconPath -Root $InstallDir)) {
        throw "$Kind shortcut icon is missing or outside the isolated installation."
    }

    Add-Type -AssemblyName System.Drawing
    if ([System.IO.Path]::GetFullPath($iconPath).Equals($expectedExe, [System.StringComparison]::OrdinalIgnoreCase)) {
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconPath)
    } else {
        $icon = [System.Drawing.Icon]::new($iconPath)
    }
    if ($null -eq $icon -or $icon.Width -le 0 -or $icon.Height -le 0) { throw "$Kind shortcut icon cannot be decoded." }
    $iconWidth = $icon.Width
    $iconHeight = $icon.Height
    $bitmap = $icon.ToBitmap()
    try {
        $evidence = Join-Path (Get-RunRoot) 'evidence'
        $rawPath = Join-Path $evidence "$Kind-shortcut-icon.png"
        $bitmap.Save($rawPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $panel = [System.Drawing.Bitmap]::new(288, 96)
        $graphics = [System.Drawing.Graphics]::FromImage($panel)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            $colors = @([System.Drawing.Color]::White, [System.Drawing.Color]::FromArgb(243, 243, 243), [System.Drawing.Color]::FromArgb(32, 32, 32))
            for ($index = 0; $index -lt $colors.Count; $index++) {
                $brush = [System.Drawing.SolidBrush]::new($colors[$index])
                try { $graphics.FillRectangle($brush, $index * 96, 0, 96, 96) } finally { $brush.Dispose() }
                $graphics.DrawImage($bitmap, [System.Drawing.Rectangle]::new(($index * 96) + 16, 16, 64, 64))
            }
            $contrastPath = Join-Path $evidence "$Kind-shortcut-contrast.png"
            $panel.Save($contrastPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $panel.Dispose()
        }
    } finally {
        $bitmap.Dispose()
        $icon.Dispose()
    }

    $relativeIcon = if ([System.IO.Path]::GetFullPath($iconPath).Equals($expectedExe, [System.StringComparison]::OrdinalIgnoreCase)) { 'Eve.exe' } else { [System.IO.Path]::GetRelativePath($InstallDir, $iconPath) }
    $State.shortcuts = @($State.shortcuts) + @([pscustomobject]@{
        kind = $Kind
        status = 'present'
        expectedByPackageConfig = $ExpectedByPackageConfig
        name = 'Eve'
        target = 'Eve.exe'
        iconSource = $relativeIcon
        iconWidth = $iconWidth
        iconHeight = $iconHeight
        rawFile = [System.IO.Path]::GetFileName($rawPath)
        contrastPreview = [System.IO.Path]::GetFileName($contrastPath)
    })
    Save-State -State $State
}

function Stop-ProcessesWithin {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($true) {
        $ownedProcesses = @(
            Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
                Where-Object {
                    $path = [string]$_.ExecutablePath
                    -not [string]::IsNullOrWhiteSpace($path) -and (Test-PathWithin -Path $path -Root $Root)
                }
        )
        if ($ownedProcesses.Count -eq 0) { return }

        foreach ($process in $ownedProcesses) {
            try { Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop } catch { }
        }

        if ([DateTime]::UtcNow -ge $deadline) {
            $remainingIds = @($ownedProcesses.ProcessId | ForEach-Object { [string]$_ }) -join ', '
            throw "Timed out waiting for isolated process(es) to exit under '$Root' (PIDs: $remainingIds)."
        }
        Start-Sleep -Milliseconds 250
    }
}

function Get-VisualUninstallerArguments {
    param([Parameter(Mandatory)][string]$InstallDir)
    $installPath = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd([char[]]@('\', '/'))
    if (-not (Test-PathWithin -Path $installPath -Root (Join-Path (Get-RunRoot) 'install'))) {
        throw "Visual uninstaller target is outside this run's isolated install directory."
    }
    return @('/S', '/currentuser', "_?=$installPath")
}

function Test-VisualUninstallerArgumentsRule {
    $installDir = Join-Path (Get-RunRoot) 'install\Programs\Eve'
    $arguments = @(Get-VisualUninstallerArguments -InstallDir $installDir)
    if ($arguments.Count -ne 3 -or $arguments[0] -ne '/S' -or $arguments[1] -ne '/currentuser' -or
        $arguments[2] -ne "_?=$([System.IO.Path]::GetFullPath($installDir))") {
        throw 'Synthetic test failed: NSIS _?= install-directory argument must be last.'
    }
    $rejected = $false
    try { $null = Get-VisualUninstallerArguments -InstallDir (Join-Path (Get-RunRoot) 'outside\Programs\Eve') } catch { $rejected = $true }
    if (-not $rejected) { throw 'Synthetic test failed: an unowned NSIS _?= target was not rejected.' }
    $spacePath = Join-Path (Get-RunRoot) 'install\Programs\Eve With Spaces'
    $spaceArguments = @(Get-VisualUninstallerArguments -InstallDir $spacePath)
    if ($spaceArguments.Count -ne 3 -or $spaceArguments[2] -ne "_?=$([System.IO.Path]::GetFullPath($spacePath))") {
        throw 'Synthetic test failed: the final NSIS _?= argument must preserve a path containing spaces.'
    }
}

function Invoke-SilentUninstall {
    param([Parameter(Mandatory)][string]$InstallDir)
    $uninstaller = Join-Path $InstallDir 'Uninstall Eve.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { return $false }
    if (-not (Test-PathWithin -Path $uninstaller -Root $InstallDir)) { throw 'Uninstaller is outside the fixed temporary install path.' }
    $keyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductGuid"
    if (-not (Test-Path -LiteralPath $keyPath)) { throw 'Cannot prove uninstall ownership because the per-user Eve registry entry is missing.' }
    $entry = Get-ItemProperty -LiteralPath $keyPath
    $ownedUninstaller = Resolve-VisualUninstallerPath -Entry $entry -InstallDir $InstallDir
    if (-not (Test-Path -LiteralPath $ownedUninstaller -PathType Leaf)) { throw 'The registry-owned uninstaller is missing.' }
    $runRoot = Get-RunRoot
    if (-not (Test-PathWithin -Path $runRoot -Root $env:RUNNER_TEMP)) { throw 'Visual uninstaller scratch directory escaped RUNNER_TEMP.' }
    $uninstallerScratch = Join-Path (Join-Path $runRoot 'temp') 'uninstaller'
    if (-not (Test-PathWithin -Path $uninstallerScratch -Root $runRoot)) { throw "Temporary uninstaller copy is outside this run's RUNNER_TEMP ownership." }
    New-Item -ItemType Directory -Path $uninstallerScratch -Force | Out-Null
    $temporaryUninstaller = Join-Path $uninstallerScratch 'Uninstall Eve.exe'
    Copy-Item -LiteralPath $ownedUninstaller -Destination $temporaryUninstaller -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $temporaryUninstaller -PathType Leaf) -or
        (Get-FileHash -LiteralPath $ownedUninstaller -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $temporaryUninstaller -Algorithm SHA256).Hash) {
        throw 'Temporary uninstaller copy does not match the registry-owned uninstaller.'
    }
    $arguments = @(Get-VisualUninstallerArguments -InstallDir $InstallDir)
    $startInfo = New-SanitizedStartInfo -FilePath $temporaryUninstaller -WorkingDirectory $InstallDir -Arguments @('/S', '/currentuser')
    $startInfo.ArgumentList.Clear()
    # NSIS requires _?= to be the last raw, unquoted argument, including when the path contains spaces.
    $startInfo.Arguments = $arguments -join ' '
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        if (-not $process.WaitForExit(180000)) { try { $process.Kill($true) } catch { }; throw 'Uninstaller timed out after 180 seconds.' }
        if ($process.ExitCode -ne 0) { throw "Uninstaller exited with code $($process.ExitCode)." }
        if (Test-Path -LiteralPath (Join-Path $InstallDir 'Eve.exe')) { throw 'Eve.exe remains after visual uninstall.' }
        return $true
    } finally {
        $process.Dispose()
    }
}

function Initialize-Run {
    Assert-CiContext
    $root = Get-RunRoot
    if (Test-Path -LiteralPath $root) { throw 'Unique RUNNER_TEMP path already exists; refusing to reuse it.' }
    New-Item -ItemType Directory -Path $root | Out-Null
    $evidence = Join-Path $root 'evidence'
    foreach ($directory in @($evidence, (Join-Path $root 'stage'), (Join-Path $root 'temp'))) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $state = [pscustomobject]@{
        schema = 1
        runId = $env:GITHUB_RUN_ID
        runAttempt = $env:GITHUB_RUN_ATTEMPT
        candidateSha = $env:EVE_VISUAL_CANDIDATE_SHA
        version = $script:ProductVersion
        status = 'initializing'
        desktop = $null
        installer = $null
        screenshots = @()
        shortcuts = @()
        diagnostics = @()
        cleanup = $null
        visualReview = 'pending-human-review'
    }
    Save-State -State $state
    try {
        $head = Assert-CandidateHead
        Test-VisualUninstallerOwnershipRule
        Test-VisualUninstallerArgumentsRule
        Test-DesktopShortcutEvidenceRules
        Test-VisualBuildSettingsRule
        $package = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'app\package.json') -Raw | ConvertFrom-Json -Depth 16
        $buildSettings = Resolve-VisualBuildSettings -Package $package
        $desktopShortcutExpected = Get-DesktopShortcutExpected -NsisOptions $buildSettings.NsisWeb
        if ($head -ne $state.candidateSha -or $package.version -ne $script:ProductVersion -or -not $buildSettings.NsisWeb.oneClick -or
            $buildSettings.Win.icon -ne 'resources/icon.ico' -or -not $desktopShortcutExpected) {
            throw 'Candidate SHA, alpha.6 version, one-click UI, installer icon, or fresh-install Desktop shortcut setting did not match this probe.'
        }
        $keyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductGuid"
        if (Test-Path -LiteralPath $keyPath) { throw 'Pre-existing Eve uninstall key found on the disposable runner.' }
        $state.status = 'initialized'
        $state.installer = [pscustomobject]@{ mode = 'oneClick'; iconResource = 'app/resources/icon.ico' }
        Save-State -State $state
    } catch {
        $state.status = 'initialization-failed'
        Add-Diagnostic -State $state -Code 'INITIALIZATION_FAILED' -Message $_.Exception.Message
        Save-State -State $state
        throw
    }
}

function Invoke-Capture {
    Assert-CiContext
    $root = Get-RunRoot
    if (-not (Test-PathWithin -Path $root -Root $env:RUNNER_TEMP) -or -not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Initialized RUNNER_TEMP directory is missing.' }
    $state = Get-Content -LiteralPath (Get-EvidencePath) -Raw | ConvertFrom-Json -Depth 12
    $installDir = Join-Path $root 'install\Programs\Eve'
    $stageDir = Join-Path $root 'stage'
    $process = $null
    $operationError = $null
    $cleanupError = $null
    try {
        if ((Assert-CandidateHead) -ne [string]$state.candidateSha) { throw 'Candidate changed after initialization.' }
        $package = Get-Content -LiteralPath (Join-Path $script:RepoRoot 'app\package.json') -Raw | ConvertFrom-Json -Depth 16
        $buildSettings = Resolve-VisualBuildSettings -Package $package
        if (Test-Path -LiteralPath $installDir) { throw 'Fixed install path already exists.' }
        $releaseDir = Join-Path $script:RepoRoot 'app\release\nsis-web'
        $names = @("Eve.Web.Setup.$script:ProductVersion.exe", "murmur-$script:ProductVersion-x64.nsis.7z")
        foreach ($name in $names) {
            $source = Join-Path $releaseDir $name
            if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or -not (Test-PathWithin -Path $source -Root $script:RepoRoot)) { throw "Required alpha.6 installer file is missing: $name" }
            Copy-Item -LiteralPath $source -Destination (Join-Path $stageDir $name)
        }
        $installerName = $names[0]
        $payloadName = $names[1]
        $installer = Join-Path $stageDir $installerName
        $payload = Join-Path $stageDir $payloadName
        $state.installer = [pscustomobject]@{
            mode = 'oneClick'
            iconResource = 'app/resources/icon.ico'
            packageFilePassedExplicitly = $true
            installPath = 'RUNNER_TEMP/eve-alpha6-installer-visual-<run>/install/Programs/Eve'
            files = @($installerName, $payloadName)
            exitCode = $null
        }

        $bounds = Get-ScreenBounds
        $state.desktop = [pscustomobject]@{ available = $true; session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; width = $bounds.Width; height = $bounds.Height }
        Save-State -State $state

        $arguments = @("--package-file=$payload", "/D=$installDir")
        $startInfo = New-SanitizedStartInfo -FilePath $installer -WorkingDirectory $stageDir -Arguments $arguments
        $process = [System.Diagnostics.Process]::Start($startInfo)
        if ($null -eq $process) { throw 'Windows did not return an installer process handle.' }
        $started = [DateTime]::UtcNow
        $lastCapture = [DateTime]::MinValue
        $captureNumber = 0
        $windowSeen = $false
        while (-not $process.HasExited) {
            $elapsed = [DateTime]::UtcNow - $started
            if ($elapsed.TotalMinutes -gt 20) { throw 'INTERACTIVE_INSTALLER_TIMEOUT: alpha.6 setup exceeded 20 minutes.' }
            $window = Get-VisibleWindow -Process $process -ScreenBounds $bounds
            if ($null -ne $window) {
                $windowSeen = $true
                if ($captureNumber -eq 0 -or (([DateTime]::UtcNow - $lastCapture).TotalSeconds -ge 15 -and $captureNumber -lt 4)) {
                    $tag = if ($captureNumber -eq 0) { 'start' } else { "progress-$captureNumber" }
                    Capture-InstallerScreen -Window $window -ProcessId $process.Id -Name $tag -State $state
                    $captureNumber++
                    $lastCapture = [DateTime]::UtcNow
                }
            } elseif (-not $windowSeen -and $elapsed.TotalSeconds -gt 60) {
                throw 'INTERACTIVE_DESKTOP_UNAVAILABLE: setup ran for 60 seconds without a visible installer window.'
            }
            [void]$process.WaitForExit(1500)
            $process.Refresh()
        }
        if ($process.ExitCode -ne 0) { throw "Interactive alpha.6 installer exited with code $($process.ExitCode)." }
        if (-not $windowSeen -or $state.screenshots.Count -eq 0) { throw 'INTERACTIVE_DESKTOP_UNAVAILABLE: setup exited without a capturable installer window.' }
        $state.installer.exitCode = $process.ExitCode

        Stop-ProcessesWithin -Root $installDir
        if (-not (Test-Path -LiteralPath (Join-Path $installDir 'Eve.exe') -PathType Leaf)) { throw 'Installer exited successfully but isolated Eve.exe is missing.' }
        $keyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductGuid"
        if (-not (Test-Path -LiteralPath $keyPath)) { throw 'Alpha.6 install entry is missing from the runner user hive.' }
        $entry = Get-ItemProperty -LiteralPath $keyPath
        $null = Resolve-VisualUninstallerPath -Entry $entry -InstallDir $installDir
        $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $startMenuLinks = @(Get-ChildItem -LiteralPath $startMenu -Filter 'Eve.lnk' -File -Recurse -ErrorAction SilentlyContinue)
        if ($startMenuLinks.Count -ne 1) { throw "Expected one Start Menu Eve shortcut; found $($startMenuLinks.Count)." }
        $desktop = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::DesktopDirectory)
        $desktopLink = Join-Path $desktop 'Eve.lnk'
        Save-ShortcutIcon -LinkPath $startMenuLinks[0].FullName -Kind 'start-menu' -InstallDir $installDir -State $state
        $desktopExpected = Get-DesktopShortcutExpected -NsisOptions $buildSettings.NsisWeb
        if (Test-Path -LiteralPath $desktopLink -PathType Leaf) {
            $null = Assert-DesktopShortcutEvidence -Exists $true -Expected $desktopExpected -Path 'Desktop\Eve.lnk'
            Save-ShortcutIcon -LinkPath $desktopLink -Kind 'desktop' -InstallDir $installDir -State $state -ExpectedByPackageConfig $desktopExpected
        } else {
            $status = if ($desktopExpected) { 'missing-required' } else { 'not-created-as-configured' }
            $state.shortcuts = @($state.shortcuts) + @([pscustomobject]@{ kind = 'desktop'; status = $status; expectedByPackageConfig = $desktopExpected })
            Save-State -State $state
            $null = Assert-DesktopShortcutEvidence -Exists $false -Expected $desktopExpected -Path 'Desktop\Eve.lnk'
        }
        $state.status = 'captured-awaiting-human-review'
        $state.visualReview = 'pending-human-review'
        Save-State -State $state
        Write-Host '[installer-visual] Captured installer and shortcut visuals; screenshots still require human visual review.'
    } catch {
        $operationError = $_
        if ($_.Exception.Message -match '^DESKTOP_SHORTCUT_MISSING:') {
            $state.status = 'capture-failed'
            Add-Diagnostic -State $state -Code 'DESKTOP_SHORTCUT_MISSING' -Message $_.Exception.Message
        } elseif ($_.Exception.Message -match '^INTERACTIVE_DESKTOP_UNAVAILABLE:') {
            $state.status = 'blocked-interactive-desktop'
            Add-Diagnostic -State $state -Code 'INTERACTIVE_DESKTOP_UNAVAILABLE' -Message $_.Exception.Message
            if ($null -eq $state.desktop) { $state.desktop = [pscustomobject]@{ available = $false; message = $_.Exception.Message } }
        } elseif ($_.Exception.Message -match '^INTERACTIVE_INSTALLER_TIMEOUT:') {
            $state.status = 'installer-timeout'
            Add-Diagnostic -State $state -Code 'INTERACTIVE_INSTALLER_TIMEOUT' -Message $_.Exception.Message
        } else {
            $state.status = 'capture-failed'
            Add-Diagnostic -State $state -Code 'CAPTURE_FAILED' -Message $_.Exception.Message
        }
        Save-State -State $state
        Write-Host "[installer-visual] $($_.Exception.Message)"
    } finally {
        try {
            Stop-ProcessesWithin -Root $root
            $didUninstall = Invoke-SilentUninstall -InstallDir $installDir
            $keyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductGuid"
            if (Test-Path -LiteralPath $keyPath) { throw 'Eve uninstall entry remained after cleanup.' }
            $state.cleanup = if ($didUninstall) { 'uninstalled' } else { 'not-installed' }
        } catch {
            $cleanupError = $_
            $state.cleanup = 'failed'
            Add-Diagnostic -State $state -Code 'CLEANUP_FAILED' -Message $_.Exception.Message
        }
        Save-State -State $state
    }
    if ($null -ne $operationError) { throw [System.InvalidOperationException]::new($operationError.Exception.Message) }
    if ($null -ne $cleanupError) { throw [System.InvalidOperationException]::new($cleanupError.Exception.Message) }
}

function Remove-Run {
    Assert-CiContext
    $root = Get-RunRoot
    if (-not (Test-Path -LiteralPath $root)) { Write-Host '[installer-visual] No scratch directory exists.'; return }
    if (-not (Test-PathWithin -Path $root -Root $env:RUNNER_TEMP) -or (Split-Path -Leaf $root) -ne "eve-alpha6-installer-visual-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT") {
        throw 'Refusing to remove a directory outside this run exact RUNNER_TEMP path.'
    }
    Stop-ProcessesWithin -Root $root
    Remove-Item -LiteralPath $root -Recurse -Force
    Write-Host '[installer-visual] Removed this run isolated scratch directory after evidence upload.'
}

try {
    Assert-CiContext
    switch ($Mode) {
        'Initialize' { Initialize-Run }
        'Capture' { Invoke-Capture }
        'Cleanup' { Remove-Run }
    }
} catch {
    Write-Error -ErrorRecord $_
    exit 1
}
