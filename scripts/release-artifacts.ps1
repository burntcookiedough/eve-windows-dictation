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
$version=if($ExpectedTag){$ExpectedTag.TrimStart('v')}else{throw 'ExpectedTag is required.'}
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
if($data.tag -ne $ExpectedTag -or $data.commit -ne $ExpectedCommit -or $data.version -ne $version){throw 'Manifest tag, commit, or version mismatch.'}
foreach($entry in $data.assets){$f=Get-Item (Join-Path $dir $entry.name);if($f.Length -ne $entry.bytes -or (Get-FileHash $f -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256 -or (Get-FileHash $f -Algorithm SHA512).Hash.ToLowerInvariant() -ne $entry.sha512){throw "Hash or byte mismatch: $($entry.name)"}}
$wrapper=Join-Path $dir "Eve.Web.Setup.$version.exe"; $signature=Get-AuthenticodeSignature $wrapper
if($AllowUnsigned){if($signature.Status -ne 'NotSigned'){throw "Expected intentionally unsigned wrapper, got $($signature.Status)."}}elseif($signature.Status -ne 'Valid'){throw "Authenticode must be Valid when allow_unsigned=false; got $($signature.Status)."}
$latest=Get-Content (Join-Path $dir 'latest.yml') -Raw
if($latest -notmatch [regex]::Escape("Eve.Web.Setup.$version.exe") -or $latest -notmatch [regex]::Escape("murmur-$version-x64.nsis.7z")){throw 'latest.yml does not bind the expected updater assets.'}
if(!(Select-String -LiteralPath (Join-Path $dir 'THIRD_PARTY_NOTICES.txt') -Pattern 'Generated from the exact pre-package closure' -Quiet)){throw 'Third-party notice asset is not the generated notice.'}
