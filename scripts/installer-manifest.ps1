Set-StrictMode -Version Latest

# QA evidence only: this manifest is not added to the payload or release assets.
function New-InstalledPayloadManifest {
    param([Parameter(Mandatory)][string]$SourceDir, [Parameter(Mandatory)][string]$OutputFile)
    $root = (Resolve-Path -LiteralPath $SourceDir -ErrorAction Stop).ProviderPath.TrimEnd('\', '/')
    $items = @((Get-Item -LiteralPath $root -Force -ErrorAction Stop)) + @(Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction Stop)
    if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        throw 'Payload reparse points are unsupported.'
    }
    $files = @($items | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
            length = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        }
    })
    if ($files.Count -eq 0) { throw 'Cannot generate an empty payload manifest.' }
    $manifest = [ordered]@{ schemaVersion = 1; fileCount = $files.Count; files = $files }
    $json = $manifest | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputFile), $json, [Text.UTF8Encoding]::new($false))
}

function Assert-InstalledPayload {
    param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$ManifestPath)
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $files = @($manifest.files)
    if ($manifest.schemaVersion -ne 1 -or $files.Count -eq 0 -or $manifest.fileCount -ne $files.Count) {
        throw 'Invalid payload manifest schema or file count.'
    }
    $root = (Resolve-Path -LiteralPath $InstallDir -ErrorAction Stop).ProviderPath.TrimEnd('\', '/')
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $files) {
        $rel = $entry.path
        if ($rel -isnot [string] -or [string]::IsNullOrWhiteSpace($rel) -or
            [IO.Path]::IsPathRooted($rel) -or $rel -match '[:\\]' -or
            $rel -match '(^|/)\.{1,2}(/|$)|(^/|//|/$|[. ](/|$))' -or -not $seen.Add($rel)) {
            throw 'Unsafe or duplicate payload manifest path.'
        }
        if (($entry.length -isnot [int] -and $entry.length -isnot [long]) -or $entry.length -lt 0 -or
            $entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw 'Invalid payload length or SHA256.'
        }
        $target = $root
        foreach ($part in $rel.Split('/')) {
            $target = Join-Path $target $part
            if (Test-Path -LiteralPath $target) {
                if ((Get-Item -LiteralPath $target -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'Installed payload reparse points are unsupported.'
                }
            }
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing installed payload file: $rel" }
        if ((Get-Item -LiteralPath $target -Force -ErrorAction Stop).Length -ne $entry.length) { throw "Payload length mismatch: $rel" }
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $entry.sha256) {
            throw "Payload SHA256 mismatch: $rel"
        }
    }
    Write-Host "[verify] Verified $($files.Count) installed files against expected lengths and SHA256."
}

function Resolve-SevenZip {
    param([string]$ExplicitPath = '', [string]$AppDir = '')
    if ($ExplicitPath) {
        return (Resolve-Path -LiteralPath $ExplicitPath -ErrorAction Stop).ProviderPath
    }
    if ($AppDir -and (Get-Command node -ErrorAction SilentlyContinue)) {
        # Use the same pinned, checksum-verified tool resolver as the builder.
        $module = Join-Path $AppDir 'node_modules/app-builder-lib/out/toolsets/7zip.js'
        $resolved = & node -e 'require(process.argv[1]).getPath7za().then(console.log).catch(e => { console.error(e.message); process.exit(1); })' $module
        if ($LASTEXITCODE -eq 0 -and $resolved -and (Test-Path -LiteralPath ([string]$resolved) -PathType Leaf)) {
            return [string]$resolved
        }
    }
    foreach ($name in @('7z.exe', '7za.exe')) {
        $tool = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($tool) { return $tool.Source }
    }
    throw '7-Zip unavailable; specify -SevenZipPath. Archive verification failed closed.'
}

function Assert-SevenZipArchiveMethods {
    param([Parameter(Mandatory)][string]$ArchivePath, [string]$SevenZipPath = '', [string]$AppDir = '')
    if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw 'Archive file not found.' }
    $tool = Resolve-SevenZip -ExplicitPath $SevenZipPath -AppDir $AppDir
    $output = & $tool l -slt -ba -- $ArchivePath
    if ($LASTEXITCODE -ne 0) { throw "7-Zip listing failed with exit code $LASTEXITCODE." }
    Assert-SevenZipListing -Listing ($output -join "`n")
}

function Assert-SevenZipListing {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Listing)
    $entries = @($Listing.Trim() -split '(?:\r?\n){2,}' | Where-Object { $_.Trim() })
    if ($entries.Count -eq 0) { throw 'Archive contains no payload entries.' }
    $fileCount = 0
    foreach ($entry in $entries) {
        $fields = @{}
        foreach ($line in ($entry -split '\r?\n')) {
            if ($line -match '^([^=]+?) = ?(.*)$') { $fields[$Matches[1]] = $Matches[2] }
        }
        if (-not $fields.ContainsKey('Path')) { throw 'Malformed 7-Zip payload listing.' }
        if (($fields.ContainsKey('Folder') -and $fields['Folder'] -eq '+') -or
            ($fields.ContainsKey('Attributes') -and $fields['Attributes'] -match '^D')) { continue }
        if (-not $fields.ContainsKey('Size') -or $fields['Size'] -notmatch '^\d+$' -or -not $fields.ContainsKey('Method')) {
            throw 'Missing payload size or method.'
        }
        $fileCount++
        $method = $fields['Method'].Trim()
        if (-not $method -and $fields['Size'] -eq '0') { continue }
        if ($method -cnotmatch '^(Copy|(BCJ )?LZMA2(?::\d+[km]?)?)$') { throw "Incompatible 7z compression method: $method" }
    }
    if ($fileCount -eq 0) { throw 'Archive contains no payload files.' }
    Write-Host "[verify] Verified compression methods for $fileCount payload files."
}
