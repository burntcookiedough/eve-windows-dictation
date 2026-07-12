# Murmur root justfile
# Run these recipes with the Windows build of `just` from any clone location.

set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

root := justfile_directory()

default:
    @just --list

# Build the packaged app (nsis-web installer + payloads in app/release/)
build:
    Set-Location (Join-Path '{{root}}' 'app'); bun run package:win

# Silently install the newest generated installer
install:
    $release = Join-Path '{{root}}' 'app\release'; $installer = Get-ChildItem -LiteralPath $release -Filter '*.exe' -File | Where-Object Name -NotLike '*Uninstall*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (-not $installer) { throw "No installer found in $release" }; Start-Process -Wait -FilePath $installer.FullName -ArgumentList '/S'

# Silently uninstall the per-user installation
uninstall:
    $uninstaller = Join-Path $env:LOCALAPPDATA 'Programs\Murmur\Uninstall Murmur.exe'; if (-not (Test-Path -LiteralPath $uninstaller)) { throw "Uninstaller not found: $uninstaller" }; Start-Process -Wait -FilePath $uninstaller -ArgumentList '/S'
