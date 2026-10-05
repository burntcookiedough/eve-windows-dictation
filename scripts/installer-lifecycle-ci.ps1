[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProductGuid = '0204d005-75b3-5b31-b1f6-ef2831e2b204'
$script:BaselineTag = 'v0.8.2-alpha.5'
$script:BaselineVersion = '0.8.2-alpha.5'
$script:CandidateVersion = '0.8.2-alpha.7'
$script:Repository = 'burntcookiedough/eve-windows-dictation'
$script:OwnedAppPid = $null
$script:OwnedServerPid = $null
$script:CurrentInstallDir = $null

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "[installer-lifecycle] $Message"
}

function Assert-PathWithin {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Root)
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
    $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith("$fullRoot$([System.IO.Path]::DirectorySeparatorChar)", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-CiHost {
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:OS -ne 'Windows_NT') {
        throw 'Installer execution is restricted to a disposable GitHub-hosted Windows runner.'
    }
    if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_WORKSPACE -or -not $env:GITHUB_SHA -or -not $env:GH_TOKEN) {
        throw 'Required GitHub Actions workspace, token, or runner paths are missing.'
    }
    $workspace = [System.IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if (-not $workspace.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The script must run from the checked-out GitHub workspace.'
    }
    $root = [System.IO.Path]::GetPathRoot($workspace)
    if (-not $root.Equals([System.IO.Path]::GetPathRoot($env:RUNNER_TEMP), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Runner temp and checkout must share a volume so build artifacts can be moved without duplicate payload copies.'
    }
    if ($env:GITHUB_EVENT_NAME -eq 'pull_request') {
        if ($env:GITHUB_HEAD_REF -ne 'codex/eve-alpha7-candidate') { throw 'Only the approved candidate PR may run this installer gate.' }
    } elseif ($env:GITHUB_REF -notin @('refs/heads/codex/eve-alpha7-candidate', 'refs/heads/trunk')) {
        throw "Unexpected ref for installer execution: $env:GITHUB_REF"
    }
}

function Invoke-GhJson {
    param([Parameter(Mandatory)][string]$Endpoint)
    $output = & gh api $Endpoint
    if ($LASTEXITCODE -ne 0) { throw "GitHub API request failed: $Endpoint" }
    return ($output | Out-String | ConvertFrom-Json -Depth 30)
}

function Resolve-TagCommit {
    param([Parameter(Mandatory)][string]$Tag)
    $ref = Invoke-GhJson -Endpoint "repos/$script:Repository/git/ref/tags/$Tag"
    $target = $ref.object
    $depth = 0
    while ($target.type -eq 'tag') {
        $depth++
        if ($depth -gt 4) { throw 'Baseline tag indirection exceeded the supported bound.' }
        $tagData = Invoke-GhJson -Endpoint "repos/$script:Repository/git/tags/$($target.sha)"
        $target = $tagData.object
    }
    if ($target.type -ne 'commit') { throw 'Published alpha.5 tag does not resolve to a commit.' }
    return [string]$target.sha
}

function Get-BaselineAssetPins {
    return @(
        [pscustomobject]@{ Name = 'murmur-0.8.2-alpha.5-x64.nsis.7z'; Id = '574608952'; Bytes = [int64]1860486151; Digest = 'sha256:ec0f67f2acb1ea6fa479a7a65e9fc712424b23335700fcd17e0a289f18631563' }
        [pscustomobject]@{ Name = 'Eve.Web.Setup.0.8.2-alpha.5.exe'; Id = '574608953'; Bytes = [int64]654605; Digest = 'sha256:1616d072bd7d230f013976f3659e9e037b2d2e212413ea78cbef2fe8e5db194c' }
        [pscustomobject]@{ Name = 'latest.yml'; Id = '574608954'; Bytes = [int64]598; Digest = 'sha256:acdb4a9ab42b15872885698a0874b1e417126e00a6ce9750abae7863d6836016' }
        [pscustomobject]@{ Name = 'SHA256SUMS.txt'; Id = '574608955'; Bytes = [int64]277; Digest = 'sha256:b40424f2c9bc980fcb8fa8795caa84c9b65d6c4d4b9c350850d311801ae0b5ee' }
        [pscustomobject]@{ Name = 'eve-v0.8.2-alpha.5-artifact-manifest.json'; Id = '574608956'; Bytes = [int64]2020; Digest = 'sha256:f3ee241f1e6ce39ace05f88b90d1c05cd526e97ce66b6e9c28cf62e335a9ada3' }
        [pscustomobject]@{ Name = 'SHA512SUMS.txt'; Id = '574608982'; Bytes = [int64]469; Digest = 'sha256:a09b70fbedc9eb42bfd4b0fde02175323e62f518c03715d2abf75ef8e655e9ca' }
        [pscustomobject]@{ Name = 'THIRD_PARTY_NOTICES.txt'; Id = '574608995'; Bytes = [int64]9927; Digest = 'sha256:f1bd635761bd739276b03083bd46518f69b7c49308c61074c18a300f443a819c' }
    )
}

function Download-VerifiedBaseline {
    param([Parameter(Mandatory)][string]$Destination)

    if (-not (Get-Command gh -ErrorAction SilentlyContinue) -or -not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        throw 'The hosted runner must provide gh and curl.exe for authenticated release asset verification.'
    }
    $resolvedTagCommit = Resolve-TagCommit -Tag $script:BaselineTag
    if ($resolvedTagCommit -ne 'f0ae5d902fbb47f4cae240a68932a5b76cf6a187') {
        throw 'Published alpha.5 tag commit differs from the pinned baseline.'
    }

    $release = Invoke-GhJson -Endpoint "repos/$script:Repository/releases/392037744"
    if ([string]$release.id -ne '392037744' -or $release.draft -ne $false -or $release.prerelease -ne $true -or
        $release.tag_name -ne $script:BaselineTag -or $release.target_commitish -ne $resolvedTagCommit) {
        throw 'The published alpha.5 release identity or state differs from the pinned baseline.'
    }

    $pins = @(Get-BaselineAssetPins)
    $assets = @($release.assets)
    if ($assets.Count -ne $pins.Count) { throw 'Published alpha.5 asset count differs from the pinned baseline.' }
    $expectedNames = @($pins.Name | Sort-Object) -join "`n"
    $actualNames = @($assets.name | Sort-Object) -join "`n"
    if ($actualNames -ne $expectedNames) { throw 'Published alpha.5 asset allowlist differs from the pinned baseline.' }

    foreach ($pin in $pins) {
        $asset = @($assets | Where-Object { $_.name -eq $pin.Name })
        if ($asset.Count -ne 1 -or [string]$asset[0].id -ne $pin.Id -or [int64]$asset[0].size -ne $pin.Bytes -or
            [string]$asset[0].digest -ne $pin.Digest -or $asset[0].state -ne 'uploaded' -or
            [string]$asset[0].url -ne "https://api.github.com/repos/$script:Repository/releases/assets/$($pin.Id)") {
            throw "Published alpha.5 asset metadata differs from its pin: $($pin.Name)"
        }
    }

    foreach ($pin in $pins | Where-Object { $_.Name -in @('Eve.Web.Setup.0.8.2-alpha.5.exe', 'murmur-0.8.2-alpha.5-x64.nsis.7z', 'eve-v0.8.2-alpha.5-artifact-manifest.json', 'SHA256SUMS.txt') }) {
        $asset = @($assets | Where-Object { $_.name -eq $pin.Name })[0]
        $targetPath = Join-Path $Destination $pin.Name
        Write-Step "Downloading pinned alpha.5 asset $($pin.Name) ($($pin.Bytes) bytes)"
        & curl.exe --silent --show-error --fail --location --retry 3 --retry-all-errors `
            --header "Authorization: Bearer $env:GH_TOKEN" `
            --header 'Accept: application/octet-stream' `
            --output $targetPath `
            $asset.url
        if ($LASTEXITCODE -ne 0) { throw "Authenticated download failed for $($pin.Name)." }
        $file = Get-Item -LiteralPath $targetPath
        $digest = 'sha256:' + (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($file.Length -ne $pin.Bytes -or $digest -ne $pin.Digest) { throw "Downloaded alpha.5 asset failed size or digest validation: $($pin.Name)" }
    }

    $manifestPath = Join-Path $Destination 'eve-v0.8.2-alpha.5-artifact-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -Depth 20
    if ($manifest.schema -ne 1 -or $manifest.tag -ne $script:BaselineTag -or $manifest.version -ne $script:BaselineVersion -or
        $manifest.commit -ne $resolvedTagCommit -or @($manifest.assets).Count -ne 6) {
        throw 'Published alpha.5 artifact manifest identity or schema is invalid.'
    }
    foreach ($entry in @($manifest.assets)) {
        $pin = @($pins | Where-Object { $_.Name -eq $entry.name })
        if ($pin.Count -ne 1 -or [int64]$entry.bytes -ne $pin[0].Bytes -or [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' -or [string]$entry.sha512 -notmatch '^[0-9a-f]{128}$' -or ('sha256:' + [string]$entry.sha256) -ne $pin[0].Digest) {
            throw "Published alpha.5 manifest entry is malformed: $($entry.name)"
        }
    }

    $checksumLines = Get-Content -LiteralPath (Join-Path $Destination 'SHA256SUMS.txt')
    $seenChecksums = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $checksumLines) {
        if ($line -notmatch '^([0-9a-fA-F]{64}) \*?(.+)$') { throw 'Published alpha.5 SHA256SUMS.txt contains a malformed entry.' }
        $name = $Matches[2]
        $entry = @($manifest.assets | Where-Object { $_.name -eq $name })
        if (-not $seenChecksums.Add($name) -or $entry.Count -ne 1 -or $Matches[1].ToLowerInvariant() -ne $entry[0].sha256) {
            throw "Published alpha.5 checksum does not agree with the manifest: $name"
        }
    }
    foreach ($name in @('Eve.Web.Setup.0.8.2-alpha.5.exe', 'murmur-0.8.2-alpha.5-x64.nsis.7z')) {
        $entry = @($manifest.assets | Where-Object { $_.name -eq $name })[0]
        $file = Get-Item -LiteralPath (Join-Path $Destination $name)
        if ($file.Length -ne [int64]$entry.bytes -or (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA512).Hash.ToLowerInvariant() -ne $entry.sha512) {
            throw "Published alpha.5 artifact does not match its SHA-512 manifest entry: $name"
        }
    }
    Write-Step "Verified published alpha.5 release assets against release ID 392037744 and its manifest."
}

function Assert-NoNvidiaDriver {
    $controllers = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop)
    $drivers = @(Get-CimInstance -ClassName Win32_PnPSignedDriver -ErrorAction Stop)
    $nvidiaController = @($controllers | Where-Object { $_.Name -match '(?i)nvidia' -or $_.PNPDeviceID -match '(?i)VEN_10DE' })
    $nvidiaDriver = @($drivers | Where-Object { $_.DeviceName -match '(?i)nvidia' -or $_.DeviceID -match '(?i)VEN_10DE' })
    $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($nvidiaController.Count -gt 0 -or $nvidiaDriver.Count -gt 0 -or $nvidiaSmi) {
        throw 'The runner has an NVIDIA display device/driver; this gate requires a clean no-NVIDIA-driver CPU host.'
    }
    Write-Step 'No NVIDIA display device, signed driver, or nvidia-smi is present.'
}

function Invoke-Installer {
    param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$InstallDir)
    if (-not (Assert-PathWithin -Path $Installer -Root $script:RunRoot) -or -not (Assert-PathWithin -Path $InstallDir -Root $script:RunRoot)) {
        throw 'Installer and install destination must stay inside the unique runner temp directory.'
    }
    $process = Start-Process -FilePath $Installer -ArgumentList @('/S', "/D=$InstallDir") -WorkingDirectory (Split-Path -Parent $Installer) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Silent installer failed with exit code $($process.ExitCode): $Installer" }
}

function Get-UninstallKeyPath {
    return "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductGuid"
}

function Resolve-RegistryUninstallerPath {
    param(
        [Parameter(Mandatory)]$Entry,
        [Parameter(Mandatory)][string]$ExpectedVersion,
        [Parameter(Mandatory)][string]$InstallDir
    )

    $displayNameProperty = $Entry.PSObject.Properties['DisplayName']
    $displayVersionProperty = $Entry.PSObject.Properties['DisplayVersion']
    $uninstallStringProperty = $Entry.PSObject.Properties['UninstallString']
    $installLocationProperty = $Entry.PSObject.Properties['InstallLocation']
    $displayName = if ($displayNameProperty) { [string]$displayNameProperty.Value } else { '' }
    $displayVersion = if ($displayVersionProperty) { [string]$displayVersionProperty.Value } else { '' }
    $uninstallString = if ($uninstallStringProperty) { [string]$uninstallStringProperty.Value } else { '' }
    $installLocation = if ($installLocationProperty) { [string]$installLocationProperty.Value } else { '' }

    if ($displayName -ne "Eve $ExpectedVersion" -or $displayVersion -ne $ExpectedVersion) {
        throw "Eve registry display identity mismatch for version $ExpectedVersion."
    }
    if ($uninstallString -notmatch '^\s*"(?<path>[^"\r\n]+\\Uninstall Eve\.exe)"\s+/currentuser\s*$') {
        throw 'Eve registry uninstall command is not the expected quoted per-user NSIS command.'
    }

    $expectedInstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd([char[]]@('\', '/'))
    $uninstallerPath = [System.IO.Path]::GetFullPath($Matches['path'])
    $expectedUninstaller = [System.IO.Path]::GetFullPath((Join-Path $expectedInstallDir 'Uninstall Eve.exe'))
    if (-not $uninstallerPath.Equals($expectedUninstaller, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Eve registry uninstall command points outside the test-owned install directory.'
    }
    if ($installLocation -and -not [System.IO.Path]::GetFullPath($installLocation).TrimEnd([char[]]@('\', '/')).Equals($expectedInstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Eve registry InstallLocation points outside the test-owned install directory.'
    }
    return $uninstallerPath
}

function Assert-RegistryState {
    param([string]$ExpectedVersion)
    $keyPath = Get-UninstallKeyPath
    $machineKey = "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$script:ProductGuid"
    if (-not $ExpectedVersion) {
        if ((Test-Path -LiteralPath $keyPath) -or (Test-Path -LiteralPath $machineKey)) { throw 'Eve uninstall registry entry remains after uninstall.' }
        return
    }
    if (-not (Test-Path -LiteralPath $keyPath) -or (Test-Path -LiteralPath $machineKey)) { throw 'Expected only the per-user Eve uninstall entry.' }
    $key = Get-ItemProperty -LiteralPath $keyPath
    $null = Resolve-RegistryUninstallerPath -Entry $key -ExpectedVersion $ExpectedVersion -InstallDir $script:CurrentInstallDir
}

function Get-ProcessById {
    param([Parameter(Mandatory)][int]$Id)
    return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $Id" -ErrorAction SilentlyContinue
}

function Assert-OwnedProcessPath {
    param([Parameter(Mandatory)]$Process, [Parameter(Mandatory)][string]$ExpectedPath, [Parameter(Mandatory)][string]$Description)
    if (-not $Process -or -not $Process.ExecutablePath -or
        -not ([System.IO.Path]::GetFullPath([string]$Process.ExecutablePath).Equals([System.IO.Path]::GetFullPath($ExpectedPath), [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "$Description PID no longer resolves to its exact test-owned executable; refusing to stop it."
    }
}

function Stop-TestProcesses {
    if ($null -ne $script:OwnedAppPid) {
        $appExe = Join-Path $script:CurrentInstallDir 'Eve.exe'
        $process = Get-ProcessById -Id ([int]$script:OwnedAppPid)
        if ($process) {
            Assert-OwnedProcessPath -Process $process -ExpectedPath $appExe -Description 'Eve app'
            Stop-Process -Id ([int]$script:OwnedAppPid) -Force
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline -and (Get-ProcessById -Id ([int]$script:OwnedAppPid))) { Start-Sleep -Milliseconds 250 }
            if (Get-ProcessById -Id ([int]$script:OwnedAppPid)) { throw 'Test-owned Eve app process did not exit.' }
        }
        $script:OwnedAppPid = $null
    }
    if ($null -ne $script:OwnedServerPid) {
        $process = Get-ProcessById -Id ([int]$script:OwnedServerPid)
        if ($process) {
            $allowedServerPaths = @(
                (Join-Path $script:CurrentInstallDir 'resources\server\.runtime\python.exe'),
                (Join-Path $script:CurrentInstallDir 'resources\server\.venv\Scripts\python.exe')
            )
            if ([string]$process.ExecutablePath -notin $allowedServerPaths) { throw 'Server PID is outside the exact installed test tree; refusing to stop it.' }
            Stop-Process -Id ([int]$script:OwnedServerPid) -Force
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Date) -lt $deadline -and (Get-ProcessById -Id ([int]$script:OwnedServerPid))) { Start-Sleep -Milliseconds 250 }
            if (Get-ProcessById -Id ([int]$script:OwnedServerPid)) { throw 'Test-owned Eve server process did not exit.' }
        }
        $script:OwnedServerPid = $null
    }
}

function Get-OptionalProperty {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Wait-ForServerPidFile {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][long]$StartedAfter, [int]$TimeoutSeconds = 180)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $appProcess = Get-ProcessById -Id ([int]$script:OwnedAppPid)
        if (-not $appProcess) { throw 'Eve exited before starting its packaged server.' }
        Assert-OwnedProcessPath -Process $appProcess -ExpectedPath (Join-Path $script:CurrentInstallDir 'Eve.exe') -Description 'Eve app'
        if (Test-Path -LiteralPath $Path) {
            try {
                $pidData = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
                $serverPid = [int](Get-OptionalProperty $pidData 'pid')
                $port = [int](Get-OptionalProperty $pidData 'port')
                $startedAt = Get-OptionalProperty $pidData 'startedAt'
                if ($null -eq $startedAt) {
                    $lastWriteTimeUtc = (Get-Item -LiteralPath $Path).LastWriteTimeUtc
                    $startedAt = [DateTimeOffset]::new($lastWriteTimeUtc).ToUnixTimeMilliseconds()
                }
                if ($serverPid -gt 0 -and $port -gt 0 -and [long]$startedAt -ge $StartedAfter) { return $pidData }
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
        Start-Sleep -Seconds 1
    }
    throw "Eve did not write a fresh packaged server PID file: $Path"
}

function Wait-ForModelReady {
    param([Parameter(Mandatory)][string]$Url, [switch]$RequireRuntimeFingerprint, [int]$TimeoutSeconds = 1500)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri $Url -Method Get -TimeoutSec 8
            $engine = Get-OptionalProperty $health 'engine'
            $engineInfo = Get-OptionalProperty $engine 'info'
            $engineStatus = Get-OptionalProperty $engine 'status'
            $engineMessage = Get-OptionalProperty $engine 'message'
            $engineModel = Get-OptionalProperty $engineInfo 'model'
            $engineDevice = Get-OptionalProperty $engineInfo 'device'
            $download = Get-OptionalProperty $health 'model_download'
            $downloadStatus = Get-OptionalProperty $download 'status'
            $downloadDetail = Get-OptionalProperty $download 'detail'
            $runtime = Get-OptionalProperty $health 'runtime'
            $effectiveDevice = Get-OptionalProperty $runtime 'effective_device'
            $diagnostics = Get-OptionalProperty $health 'diagnostics'
            $cuda = Get-OptionalProperty $diagnostics 'cuda'
            $cudaAvailable = Get-OptionalProperty $cuda 'available'

            if ($engineStatus -eq 'error') { throw "Packaged model preparation failed: $engineMessage" }
            if ($downloadStatus -eq 'error') { throw "Packaged model download failed: $downloadDetail" }
            if ($engineStatus -eq 'ready' -and $engineModel -eq 'tiny' -and $downloadStatus -eq 'ready') {
                if (($RequireRuntimeFingerprint -and $effectiveDevice -ne 'cpu') -or $engineDevice -ne 'cpu') {
                    throw "Packaged server did not report CPU inference: effective=$effectiveDevice, engine=$engineDevice"
                }
                if ($cudaAvailable -eq $true) { throw 'CUDA unexpectedly became available on the required no-NVIDIA runner.' }
                return $health
            }
        } catch {
            if ($_.Exception.Message -match 'Packaged model|CPU inference|CUDA unexpectedly') { throw }
        }
        Start-Sleep -Seconds 2
    }
    throw "Whisper tiny did not become CPU-ready within ${TimeoutSeconds}s at $Url."
}

function Assert-ShortcutAndIcon {
    param([Parameter(Mandatory)][string]$InstallDir)
    $exePath = Join-Path $InstallDir 'Eve.exe'
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw "Installed Eve.exe is missing: $exePath" }
    $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
    if ([string]$versionInfo.ProductName -ne 'Eve') { throw "Installed executable ProductName is not Eve: $($versionInfo.ProductName)" }

    Add-Type -AssemblyName System.Drawing
    $extractedIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath)
    if (-not $extractedIcon -or $extractedIcon.Width -le 0 -or $extractedIcon.Height -le 0) { throw 'Installed Eve.exe has no readable associated icon resource.' }
    $extractedIcon.Dispose()

    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $shell = New-Object -ComObject WScript.Shell
    $shortcuts = @(Get-ChildItem -LiteralPath $startMenu -Filter 'Eve.lnk' -File -Recurse -ErrorAction SilentlyContinue)
    if ($shortcuts.Count -ne 1) { throw "Expected exactly one Start Menu Eve shortcut, found $($shortcuts.Count)." }
    $shortcut = $shell.CreateShortcut($shortcuts[0].FullName)
    if (-not ([System.IO.Path]::GetFullPath($shortcut.TargetPath).Equals([System.IO.Path]::GetFullPath($exePath), [System.StringComparison]::OrdinalIgnoreCase))) {
        throw "Start Menu shortcut does not target the installed Eve.exe: $($shortcut.TargetPath)"
    }
    $iconPath = ([string]$shortcut.IconLocation -replace ',\s*-?\d+$', '').Trim().Trim('"')
    if (-not $iconPath -or -not (Test-Path -LiteralPath $iconPath -PathType Leaf) -or -not (Assert-PathWithin -Path $iconPath -Root $InstallDir)) {
        throw "Start Menu shortcut icon path is missing or outside the Eve installation: $iconPath"
    }
    if ([System.IO.Path]::GetFullPath($iconPath).Equals([System.IO.Path]::GetFullPath($exePath), [System.StringComparison]::OrdinalIgnoreCase)) {
        $shortcutIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconPath)
    } else {
        $shortcutIcon = [System.Drawing.Icon]::new($iconPath)
    }
    if (-not $shortcutIcon -or $shortcutIcon.Width -le 0 -or $shortcutIcon.Height -le 0) { throw 'Start Menu shortcut icon resource could not be loaded.' }
    $shortcutIcon.Dispose()
    Write-Step "Installed Eve.exe and shortcut icon verified at $InstallDir."
}

function Assert-Installed {
    param([Parameter(Mandatory)][string]$Version)
    $exePath = Join-Path $script:CurrentInstallDir 'Eve.exe'
    if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw "Installed Eve.exe is missing for $Version." }
    Assert-RegistryState -ExpectedVersion $Version
    Assert-ShortcutAndIcon -InstallDir $script:CurrentInstallDir
}

function Assert-SyntheticSentinels {
    $userData = Join-Path $script:ProfileRoot 'Eve'
    $profileSentinel = Join-Path $userData 'installer-lifecycle-sentinel.txt'
    $cacheSentinel = Join-Path $script:CacheRoot 'installer-lifecycle-sentinel.txt'
    if (-not (Test-Path -LiteralPath $profileSentinel -PathType Leaf) -or (Get-Content -LiteralPath $profileSentinel -Raw) -ne 'eve-alpha7-profile-sentinel') {
        throw 'Synthetic Eve profile sentinel was removed or changed.'
    }
    if (-not (Test-Path -LiteralPath $cacheSentinel -PathType Leaf) -or (Get-Content -LiteralPath $cacheSentinel -Raw) -ne 'eve-alpha7-cache-sentinel') {
        throw 'Synthetic model cache sentinel was removed or changed.'
    }
}

function Launch-And-Verify {
    param([Parameter(Mandatory)][string]$Version)
    $exePath = Join-Path $script:CurrentInstallDir 'Eve.exe'
    $pidFile = Join-Path (Join-Path $script:ProfileRoot 'Eve') 'server.pid'
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    $launchStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $arguments = @('--eve-qa-isolation', "--eve-qa-user-data-root=`"$(Join-Path $script:ProfileRoot 'Eve')`"")
    $app = Start-Process -FilePath $exePath -ArgumentList $arguments -WorkingDirectory $script:CurrentInstallDir -WindowStyle Hidden -PassThru
    $script:OwnedAppPid = $app.Id
    try {
        $pidData = Wait-ForServerPidFile -Path $pidFile -StartedAfter $launchStartedAt
        $serverProcess = Get-ProcessById -Id ([int]$pidData.pid)
        $allowedServerPaths = @(
            (Join-Path $script:CurrentInstallDir 'resources\server\.runtime\python.exe'),
            (Join-Path $script:CurrentInstallDir 'resources\server\.venv\Scripts\python.exe')
        )
        if (-not $serverProcess -or [string]$serverProcess.ExecutablePath -notin $allowedServerPaths) {
            throw 'PID file does not identify a server process inside the current Eve installation.'
        }
        $script:OwnedServerPid = [int]$pidData.pid
        $requireRuntimeFingerprint = $Version -eq $script:CandidateVersion
        $health = Wait-ForModelReady -Url "http://127.0.0.1:$([int]$pidData.port)/health" -RequireRuntimeFingerprint:$requireRuntimeFingerprint
        if ($health.version -ne $Version) { throw "Packaged server version mismatch: expected $Version, got $($health.version)." }
        Write-Step "Eve $Version server is healthy and Whisper tiny is ready on CPU."
        return $health
    } finally {
        Stop-TestProcesses
    }
}

function Invoke-InstalledCpuInference {
    $serverRoot = Join-Path $script:CurrentInstallDir 'resources\server'
    $pythonExe = Join-Path $serverRoot '.runtime\python.exe'
    $sitePackages = Join-Path $serverRoot '.venv\Lib\site-packages'
    $audioPath = Join-Path $script:RepoRoot 'server\tests\ui\test_audio.wav'
    if (-not (Test-Path -LiteralPath $pythonExe -PathType Leaf) -or -not (Test-Path -LiteralPath $sitePackages -PathType Container)) {
        throw 'Installed alpha.7 bundled Python or Faster-Whisper environment is missing.'
    }
    if (-not (Test-Path -LiteralPath $audioPath -PathType Leaf) -or -not (Assert-PathWithin -Path $audioPath -Root $script:RepoRoot)) {
        throw 'The repository-controlled transcription fixture is missing or outside the checkout.'
    }

    $probeScript = @'
import ctypes
import ctypes.wintypes as wintypes
import json
import logging
import os
import re
import sys

logging.disable(logging.CRITICAL)
server_root, site_packages = sys.argv[1], sys.argv[2]
sys.path.insert(0, site_packages)
sys.path.insert(0, os.path.join(server_root, "src"))
from faster_whisper import WhisperModel

model = WhisperModel("tiny", device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[3], language="en", beam_size=1, vad_filter=False)
recognized = [segment.text.strip() for segment in segments if segment.text.strip()]
text = " ".join(recognized).strip()

class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD), ("modBaseAddr", ctypes.POINTER(wintypes.BYTE)),
        ("modBaseSize", wintypes.DWORD), ("hModule", wintypes.HANDLE),
        ("szModule", wintypes.WCHAR * 256), ("szExePath", wintypes.WCHAR * 260),
    ]

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.Module32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
kernel32.Module32FirstW.restype = wintypes.BOOL
kernel32.Module32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
kernel32.Module32NextW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
snapshot = kernel32.CreateToolhelp32Snapshot(0x00000008 | 0x00000010, os.getpid())
if snapshot in (None, ctypes.c_void_p(-1).value):
    raise ctypes.WinError(ctypes.get_last_error())
modules = []
try:
    entry = MODULEENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    ok = kernel32.Module32FirstW(snapshot, ctypes.byref(entry))
    while ok:
        modules.append(entry.szModule)
        ok = kernel32.Module32NextW(snapshot, ctypes.byref(entry))
finally:
    kernel32.CloseHandle(snapshot)

nvidia_modules = sorted({name.lower() for name in modules if re.match(r"^(cublas.*\.dll|nvcuda\.dll)$", name, re.IGNORECASE)})
print(json.dumps({
    "has_text": bool(text),
    "segment_count": len(recognized),
    "character_count": len(text),
    "nvidia_modules": nvidia_modules,
}, separators=(",", ":")))
'@
    $output = & $pythonExe -c $probeScript $serverRoot $sitePackages $audioPath
    if ($LASTEXITCODE -ne 0) { throw "Bundled CPU transcription probe failed with exit code $LASTEXITCODE." }
    $report = ($output | Out-String | ConvertFrom-Json -Depth 10)
    if ($report.has_text -ne $true -or [int]$report.segment_count -le 0 -or [int]$report.character_count -le 0) {
        throw 'Installed alpha.7 CPU inference returned no transcription text.'
    }
    if (@($report.nvidia_modules).Count -ne 0) { throw "CPU inference loaded NVIDIA modules: $(@($report.nvidia_modules) -join ', ')" }
    Write-Step "Installed alpha.7 CPU inference produced text (segments=$($report.segment_count), characters=$($report.character_count)); no cuBLAS/nvcuda modules loaded."
}

function Uninstall-Current {
    param([Parameter(Mandatory)][string]$Version)
    Stop-TestProcesses
    Assert-RegistryState -ExpectedVersion $Version
    $key = Get-ItemProperty -LiteralPath (Get-UninstallKeyPath)
    $uninstaller = Resolve-RegistryUninstallerPath -Entry $key -ExpectedVersion $Version -InstallDir $script:CurrentInstallDir
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw "Eve $Version uninstaller is missing." }
    $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -WorkingDirectory $script:CurrentInstallDir -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Eve $Version uninstaller failed with exit code $($process.ExitCode)." }
    Assert-RegistryState -ExpectedVersion ''
    if (Test-Path -LiteralPath (Join-Path $script:CurrentInstallDir 'Eve.exe')) { throw "Eve $Version executable remains after uninstall." }
    $links = @(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Filter 'Eve.lnk' -File -Recurse -ErrorAction SilentlyContinue)
    if ($links.Count -ne 0) { throw 'Eve Start Menu shortcut remains after uninstall.' }
    Assert-SyntheticSentinels
    Write-Step "Eve $Version uninstalled; HKCU uninstall entry and shortcut are gone, synthetic data remains."
}

function Move-And-CleanBuildOutput {
    param([Parameter(Mandatory)][string]$CandidateDir)
    $source = Join-Path $PSScriptRoot '..\app\release\nsis-web'
    $source = [System.IO.Path]::GetFullPath($source)
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Candidate nsis-web output is missing: $source" }
    $names = @(
        "Eve.Web.Setup.$script:CandidateVersion.exe",
        "murmur-$script:CandidateVersion-x64.nsis.7z",
        'latest.yml'
    )
    foreach ($name in $names) {
        $path = Join-Path $source $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Candidate installer output is missing: $name" }
        Move-Item -LiteralPath $path -Destination $CandidateDir
    }
    $latest = Get-Content -LiteralPath (Join-Path $CandidateDir 'latest.yml') -Raw
    if ($latest -notmatch [regex]::Escape($script:CandidateVersion) -or $latest -notmatch 'murmur-0\.8\.2-alpha\.7-x64\.nsis\.7z') {
        throw 'Candidate latest.yml does not identify the alpha.7 setup and payload.'
    }
    foreach ($relative in @('app\release', 'app\node_modules', 'server\.venv', 'server\.runtime')) {
        $path = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $PSScriptRoot '..') $relative))
        if (-not (Assert-PathWithin -Path $path -Root $script:RepoRoot)) { throw "Refusing build cleanup outside checkout: $path" }
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    Write-Step 'Moved candidate installer artifacts to runner temp and removed only CI build caches.'
}

Assert-CiHost
$script:RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:RunRoot = Join-Path $env:RUNNER_TEMP "eve-alpha7-installer-lifecycle-$env:GITHUB_RUN_ID"
if (Test-Path -LiteralPath $script:RunRoot) { throw 'Unique runner temp lifecycle directory already exists; refusing to clear it.' }
New-Item -ItemType Directory -Path $script:RunRoot | Out-Null
if (-not (Assert-PathWithin -Path $script:RunRoot -Root $env:RUNNER_TEMP)) { throw 'Lifecycle scratch directory escaped runner temp.' }

$script:CandidateArtifactDir = Join-Path $script:RunRoot 'candidate'
$script:BaselineArtifactDir = Join-Path $script:RunRoot 'baseline'
$script:InstallDir = Join-Path $script:RunRoot 'install\Programs\Eve'
$script:ProfileRoot = Join-Path $script:RunRoot 'profile'
$script:CacheRoot = Join-Path $script:RunRoot 'hf'
foreach ($directory in @($script:CandidateArtifactDir, $script:BaselineArtifactDir, (Split-Path -Parent $script:InstallDir), $script:ProfileRoot, $script:CacheRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$script:CurrentInstallDir = $script:InstallDir

$script:UninstallKey = Get-UninstallKeyPath
Assert-RegistryState -ExpectedVersion ''
if (Test-Path -LiteralPath $script:InstallDir) { throw 'Test install destination exists before the run.' }
if (Test-Path -LiteralPath (Join-Path $script:ProfileRoot 'Eve')) { throw 'Synthetic app profile exists before the first install.' }

Assert-NoNvidiaDriver
Move-And-CleanBuildOutput -CandidateDir $script:CandidateArtifactDir
Download-VerifiedBaseline -Destination $script:BaselineArtifactDir

$profileSentinel = Join-Path $script:ProfileRoot 'Eve\installer-lifecycle-sentinel.txt'
$cacheSentinel = Join-Path $script:CacheRoot 'installer-lifecycle-sentinel.txt'
Set-Content -LiteralPath $cacheSentinel -Value 'eve-alpha7-cache-sentinel' -NoNewline
$env:HF_HOME = $script:CacheRoot
$env:HF_HUB_CACHE = Join-Path $script:CacheRoot 'hub'
$env:MURMUR_ENGINE = 'whisper'
$env:MURMUR_WHISPER_MODEL = 'tiny'
$env:MURMUR_WHISPER_DEVICE = 'cpu'
$env:MURMUR_WHISPER_COMPUTE_TYPE = 'int8'
$env:CUDA_VISIBLE_DEVICES = '-1'
$env:PYTHONNOUSERSITE = '1'

$baselineInstaller = Join-Path $script:BaselineArtifactDir 'Eve.Web.Setup.0.8.2-alpha.5.exe'
$candidateInstaller = Join-Path $script:CandidateArtifactDir 'Eve.Web.Setup.0.8.2-alpha.7.exe'
$baselinePayload = Join-Path $script:BaselineArtifactDir 'murmur-0.8.2-alpha.5-x64.nsis.7z'
$candidatePayload = Join-Path $script:CandidateArtifactDir 'murmur-0.8.2-alpha.7-x64.nsis.7z'
foreach ($path in @($baselineInstaller, $candidateInstaller, $baselinePayload, $candidatePayload)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Verified installer or web payload is missing: $path" }
}

try {
    Write-Step 'Installing published alpha.5 baseline into the temporary install directory.'
    Invoke-Installer -Installer $baselineInstaller -InstallDir $script:InstallDir
    Assert-Installed -Version $script:BaselineVersion
    Launch-And-Verify -Version $script:BaselineVersion | Out-Null
    Set-Content -LiteralPath $profileSentinel -Value 'eve-alpha7-profile-sentinel' -NoNewline
    Assert-SyntheticSentinels

    Write-Step 'Upgrading alpha.5 in place to the locally built alpha.7 candidate.'
    Invoke-Installer -Installer $candidateInstaller -InstallDir $script:InstallDir
    Assert-Installed -Version $script:CandidateVersion
    Assert-SyntheticSentinels
    Launch-And-Verify -Version $script:CandidateVersion | Out-Null
    Assert-SyntheticSentinels
    Invoke-InstalledCpuInference

    Write-Step 'Rolling back by uninstalling alpha.7 and reinstalling the published alpha.5 baseline.'
    Uninstall-Current -Version $script:CandidateVersion
    Invoke-Installer -Installer $baselineInstaller -InstallDir $script:InstallDir
    Assert-Installed -Version $script:BaselineVersion
    Assert-SyntheticSentinels
    Launch-And-Verify -Version $script:BaselineVersion | Out-Null
    Assert-SyntheticSentinels

    Write-Step 'Uninstalling the rolled-back baseline.'
    Uninstall-Current -Version $script:BaselineVersion
    Write-Step 'PASS: clean CPU install, alpha.5 to alpha.7 upgrade, alpha.5 rollback, and uninstall completed.'
    Write-Step 'Silent installer UI was exercised; visual installer dialogs/popups were not inspected.'
} finally {
    Stop-TestProcesses
}
