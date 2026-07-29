[CmdletBinding()]
param(
  [ValidateSet('Create','Verify')][string]$Mode = 'Verify',
  [Parameter(Mandatory=$true)][string]$ArtifactDir,
  [string]$ExpectedTag,
  [string]$ExpectedCommit,
  [string]$ExpectedManifestSha256,
  [switch]$AllowUnsigned
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$dir=(Resolve-Path $ArtifactDir).Path
if($ExpectedTag -notmatch '^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$'){throw 'ExpectedTag must be an exact v-prefixed semantic version.'}
$version=$Matches[1]
if($ExpectedCommit -notmatch '^[0-9a-f]{40}$'){throw 'ExpectedCommit must be a lowercase 40-character SHA.'}
if($Mode -eq 'Verify' -and $ExpectedManifestSha256 -notmatch '^[0-9a-fA-F]{64}$'){throw 'ExpectedManifestSha256 must be 64 hex characters.'}
$names=@("Eve.Web.Setup.$version.exe","murmur-$version-x64.nsis.7z",'latest.yml',"eve-v$version-artifact-manifest.json",'SHA256SUMS.txt','SHA512SUMS.txt','THIRD_PARTY_NOTICES.txt')
$files=Get-ChildItem $dir -File
$actual=@($files.Name | Sort-Object); $expected=@($names | Sort-Object)
if((Compare-Object $actual $expected)){throw "Release asset allowlist mismatch. Expected exactly: $($names -join ', ')"}
foreach($file in $files){if($file.Length -ge 2100000000){throw "Asset exceeds 2.10 GB safety ceiling: $($file.Name)"}}
$manifest=Join-Path $dir "eve-v$version-artifact-manifest.json"
if($Mode -eq 'Create'){
  $entries=@(); foreach($name in $names | Where-Object {$_ -ne (Split-Path $manifest -Leaf)}){$f=Get-Item (Join-Path $dir $name);$entries += [ordered]@{name=$f.Name;bytes=$f.Length;sha256=(Get-FileHash $f -Algorithm SHA256).Hash.ToLowerInvariant();sha512=(Get-FileHash $f -Algorithm SHA512).Hash.ToLowerInvariant()}}
  [ordered]@{schema=1;tag=$ExpectedTag;commit=$ExpectedCommit;version=$version;assets=$entries}|ConvertTo-Json -Depth 5|Set-Content $manifest -Encoding utf8
  return
}
if(!(Test-Path $manifest)){throw 'Manifest is missing.'}
if((Get-FileHash $manifest -Algorithm SHA256).Hash -ne $ExpectedManifestSha256.ToUpperInvariant()){throw 'Manifest SHA-256 mismatch.'}
$data=Get-Content $manifest -Raw|ConvertFrom-Json
if($data.schema -ne 1 -or $data.tag -notmatch '^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $data.commit -notmatch '^[0-9a-f]{40}$' -or $data.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $data.tag -ne $ExpectedTag -or $data.commit -ne $ExpectedCommit -or $data.version -ne $version){throw 'Manifest schema, format, tag, commit, or version mismatch.'}
$manifestNames=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach($entry in $data.assets){if(!$manifestNames.Add([string]$entry.name) -or $entry.name -notin $names -or $entry.name -eq (Split-Path $manifest -Leaf) -or [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' -or [string]$entry.sha512 -notmatch '^[0-9a-f]{128}$' -or [int64]$entry.bytes -lt 0){throw 'Manifest asset entry is malformed.'};$f=Get-Item (Join-Path $dir $entry.name);if($f.Length -ne $entry.bytes -or (Get-FileHash $f -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256 -or (Get-FileHash $f -Algorithm SHA512).Hash.ToLowerInvariant() -ne $entry.sha512){throw "Hash or byte mismatch: $($entry.name)"}}
if($manifestNames.Count -ne ($names.Count-1)){throw 'Manifest asset count mismatch.'}
foreach($algorithm in @('SHA256','SHA512')){foreach($line in Get-Content (Join-Path $dir "$algorithm`SUMS.txt")){if($line -notmatch '^([0-9a-fA-F]+) \*?(.+)$'){throw "Malformed $algorithm checksum line."};$entry=$data.assets|Where-Object name -eq $Matches[2];if(!$entry -or $Matches[1].ToLowerInvariant() -ne [string]$entry.("sha$($algorithm.Substring(3))")){throw "$algorithm checksum does not match manifest."}}}
$wrapper=Join-Path $dir "Eve.Web.Setup.$version.exe"; $signature=Get-AuthenticodeSignature $wrapper
if($AllowUnsigned){if($signature.Status -ne 'NotSigned'){throw "Expected intentionally unsigned wrapper, got $($signature.Status)."}}elseif($signature.Status -ne 'Valid'){throw "Authenticode must be Valid when allow_unsigned=false; got $($signature.Status)."}
$latest=Get-Content (Join-Path $dir 'latest.yml') -Raw
$top=@{};$file=@{};$package=@{};$state='top'
foreach($line in ($latest -split "`r?`n")){
  if($line -eq ''){continue}
  if($line -match '^files:$'){if($state -ne 'top' -or $top.Contains('files')){throw 'Malformed or duplicate latest.yml files section.'};$top.files=$true;$state='files';continue}
  if($line -match '^  - url: ([^\s]+)$'){if($state -ne 'files' -or $file.Count){throw 'Malformed or duplicate latest.yml file entry.'};$file.url=$Matches[1];continue}
  if($state -eq 'files' -and $line -match '^    (sha512|size): ([^\s]+)$'){if(!$file.Contains('url') -or $file.Contains($Matches[1])){throw 'Malformed or duplicate latest.yml file property.'};$file[$Matches[1]]=$Matches[2];continue}
  if($line -match '^packages:$'){if($state -ne 'top' -or $top.Contains('packages')){throw 'Malformed or duplicate latest.yml packages section.'};$top.packages=$true;$state='packages';continue}
  if($line -match '^  x64:$'){if($state -ne 'packages' -or $package.Count){throw 'Malformed or duplicate latest.yml x64 package.'};$package.present=$true;$state='package';continue}
  if($state -eq 'package' -and $line -match '^    (size|sha512|blockMapSize|path|file): ([^\s]+)$'){if($package.Contains($Matches[1])){throw 'Malformed or duplicate latest.yml package property.'};$package[$Matches[1]]=$Matches[2];continue}
  if($line -match '^(version|path|sha512|releaseDate): (.+)$'){if($state -eq 'files' -and !$file.Contains('sha512')){throw 'Incomplete latest.yml file entry.'};if($state -eq 'package' -and (!$package.Contains('size') -or !$package.Contains('sha512') -or !$package.Contains('path') -or !$package.Contains('file'))){throw 'Incomplete latest.yml package entry.'};$state='top';if($top.Contains($Matches[1])){throw 'Duplicate latest.yml field.'};$top[$Matches[1]]=$Matches[2].Trim("'");continue}
  throw "Unknown or malformed latest.yml line: $line"
}
if(!$top.Contains('version') -or !$top.Contains('path') -or !$top.Contains('sha512') -or !$top.Contains('releaseDate') -or !$file.Contains('url') -or !$file.Contains('sha512') -or !$package.Contains('size') -or !$package.Contains('sha512') -or !$package.Contains('path') -or !$package.Contains('file')){throw 'Missing required latest.yml fields.'}
if($top.version -ne $version -or $top.path -ne "Eve.Web.Setup.$version.exe" -or $file.url -ne $top.path -or $package.path -ne "murmur-$version-x64.nsis.7z" -or $package.file -ne $package.path -or $package.size -notmatch '^\d+$' -or ($file.Contains('size') -and $file.size -notmatch '^\d+$')){throw 'latest.yml identity or numeric fields mismatch.'}
$fileSize=if($file.Contains('size')){$file['size']}else{$null}
$latestAssets=@(
  [pscustomobject]@{Name=$top.path;Sha512=$top.sha512;Size=$null}
  [pscustomobject]@{Name=$file.url;Sha512=$file.sha512;Size=$fileSize}
  [pscustomobject]@{Name=$package.path;Sha512=$package.sha512;Size=$package.size}
)
foreach($pair in $latestAssets){$manifestEntry=$data.assets|Where-Object name -eq $pair.Name;if(!$manifestEntry){throw 'latest.yml asset missing from manifest.'};$expectedBase64=[Convert]::ToBase64String([Convert]::FromHexString([string]$manifestEntry.sha512));if($pair.Sha512 -ne $expectedBase64 -or ($null -ne $pair.Size -and [int64]$pair.Size -ne [int64]$manifestEntry.bytes)){throw 'latest.yml hash or size mismatch.'}}
if(!(Select-String -LiteralPath (Join-Path $dir 'THIRD_PARTY_NOTICES.txt') -Pattern 'Generated from the exact pre-package closure' -Quiet)){throw 'Third-party notice asset is not the generated notice.'}
