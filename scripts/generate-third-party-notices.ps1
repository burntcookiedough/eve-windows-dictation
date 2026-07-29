[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$app = Join-Path $RepositoryRoot 'app'
$server = Join-Path $RepositoryRoot 'server'
$output = Join-Path $app 'resources\generated\legal'
$overrides = Get-Content (Join-Path $RepositoryRoot 'config\third-party-license-overrides.json') -Raw | ConvertFrom-Json
$overrideLookup=@{}
foreach($property in $overrides.overrides.PSObject.Properties){$overrideLookup[$property.Name.Trim().ToLowerInvariant()]=$property.Value}
New-Item -ItemType Directory -Force -Path $output | Out-Null
$items = [System.Collections.Generic.List[object]]::new()
function Add-Component([string]$Name,[string]$Version,[string]$Kind,[string]$Path,[string]$License,[string]$Source) {
  if ([string]::IsNullOrWhiteSpace($License) -or [string]::IsNullOrWhiteSpace($Source)) { throw "Unclassified shipped component: $Name" }
  $items.Add([ordered]@{name=$Name;version=$Version;kind=$Kind;path=$Path;license=$License;source=$Source})
}
function Normalize-License([string]$Value) { if($null -eq $Value){return ''};$normalized=$Value.Trim();if($normalized -match '^(?i:unknown|none|n/?a)$'){return ''};return $normalized }
foreach($required in @('LICENSE','NOTICE.md','THIRD_PARTY_NOTICES.md')) { if(!(Test-Path (Join-Path $RepositoryRoot $required))){ throw "Missing project notice input: $required" } }
function Resolve-NodePackage([string]$Name,[string]$FromDirectory) {
  $cursor=$FromDirectory
  while($true) {
    $candidate=Join-Path $cursor (Join-Path 'node_modules' (Join-Path $Name 'package.json'))
    if(Test-Path -LiteralPath $candidate){return (Resolve-Path $candidate).Path}
    $parent=Split-Path $cursor -Parent
    if($parent -eq $cursor){return $null}; $cursor=$parent
  }
}
$rootPackage=Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
$pending=[System.Collections.Generic.Queue[string]]::new()
foreach($property in $rootPackage.dependencies.PSObject.Properties){$pending.Enqueue($property.Name)}
$visited=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
while($pending.Count -gt 0) {
  $requested=$pending.Dequeue(); $pkgPath=Resolve-NodePackage $requested $app
  if($null -eq $pkgPath){throw "Production Node dependency could not be resolved: $requested"}
  if(-not $visited.Add($pkgPath)){continue}
  $data=Get-Content $pkgPath -Raw|ConvertFrom-Json; if(!$data.name){throw "Node package lacks a name: $pkgPath"}
  $dir=Split-Path $pkgPath -Parent; $licenseFile=Get-ChildItem $dir -File|Where-Object {$_.Name -like 'LICENSE*' -or $_.Name -like 'COPYING*' -or $_.Name -like 'NOTICE*'}|Select-Object -First 1
  $override=$overrideLookup[[string]$data.name.Trim().ToLowerInvariant()]
  $license=Normalize-License ([string]$data.license); if(!$license -and $override){$license=Normalize-License ([string]$override.license)}; $source=if($licenseFile){$licenseFile.FullName}elseif($override){[string]$override.source}elseif($license){"package metadata: $pkgPath"}else{''}
  Add-Component $data.name ([string]$data.version) 'node' ($pkgPath.Substring($RepositoryRoot.Length+1)) $license $source
  foreach($groupName in @('dependencies','optionalDependencies')){$groupProperty=$data.PSObject.Properties[$groupName];if($null -ne $groupProperty){foreach($property in $groupProperty.Value.PSObject.Properties){$pending.Enqueue($property.Name)}}}
}
foreach($dist in Get-ChildItem (Join-Path $server '.venv\Lib\site-packages') -Directory -Filter '*.dist-info' -ErrorAction SilentlyContinue) {
  $meta=Join-Path $dist.FullName 'METADATA'; $name=$dist.Name; $version='unknown'; $license=''; if(Test-Path $meta){$m=Get-Content $meta -Raw; if($m -match '(?m)^Name: (.+)$'){$name=$Matches[1].Trim()}; if($m -match '(?m)^Version: (.+)$'){$version=$Matches[1].Trim()}; if($m -match '(?m)^License-Expression: (.+)$'){$license=$Matches[1].Trim()}elseif($m -match '(?m)^License: (.+)$'){$license=$Matches[1].Trim()}}
  $license=Normalize-License $license; $licenseFile=Get-ChildItem $dist.FullName -Recurse -File | Where-Object {$_.Name -like 'LICENSE*' -or $_.Name -like 'COPYING*' -or $_.Name -like 'NOTICE*'} | Select-Object -First 1; $override=$overrideLookup[[string]$name.Trim().ToLowerInvariant()]
  if(!$license -and $licenseFile){$licenseText=Get-Content $licenseFile.FullName -Raw;$isBsd3=($licenseText -match '(?is)redistributions of source code.*retain') -and ($licenseText -match '(?is)redistributions in binary form.*reproduce') -and ($licenseText -match '(?is)neither the name.*endorse or promote') -and ($licenseText -match '(?is)this software is provided.*as is');if($licenseText -match '(?i)the mit license|permission is hereby granted, free of charge'){ $license='MIT' }elseif($licenseText -match '(?i)apache license.{0,40}2\.0'){ $license='Apache-2.0' }elseif($licenseText -match '(?i)bsd' -or $isBsd3){ $license='BSD-3-Clause' }}
  if($name -eq 'murmur'){$license='MIT';$source=(Join-Path $RepositoryRoot 'LICENSE')} elseif(!$license -and $override){$license=[string]$override.license}; $source=if($source){$source}elseif($licenseFile){$licenseFile.FullName}elseif($override){[string]$override.source}elseif($license){"METADATA: $meta"}else{''}
  Add-Component $name $version 'python' ($dist.FullName.Substring($RepositoryRoot.Length+1)) $license $source
}
foreach($name in @('LICENSE.electron.txt','LICENSES.chromium.html')) { Add-Component $name '' 'electron' $name 'embedded' $name }
foreach($native in $overrides.native.psobject.Properties){ Add-Component $native.Name '' 'native' 'packaged runtime (verified post-package)' ([string]$native.Value.license) ([string]$native.Value.source) }
$items = @($items | Sort-Object kind,name,version)
$items | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'THIRD_PARTY_INVENTORY.json') -Encoding utf8
$text = "Eve third-party notices`r`nGenerated from the exact pre-package closure; verify post-package before release.`r`n`r`n" + (($items | ForEach-Object { "$($_.kind): $($_.name) $($_.version) | $($_.license) | $($_.source)" }) -join "`r`n")
$text | Set-Content (Join-Path $output 'THIRD_PARTY_NOTICES.txt') -Encoding utf8
Copy-Item (Join-Path $RepositoryRoot 'LICENSE') (Join-Path $output 'LICENSE.txt') -Force
Copy-Item (Join-Path $RepositoryRoot 'NOTICE.md') (Join-Path $output 'NOTICE.txt') -Force
Copy-Item (Join-Path $RepositoryRoot 'THIRD_PARTY_NOTICES.md') (Join-Path $output 'THIRD_PARTY_NOTICES_SOURCE.md') -Force
