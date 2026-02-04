# Murmur root justfile
# Build, install, and uninstall the packaged app

pwsh := "/mnt/c/Program\\ Files/PowerShell/7/pwsh.exe"

# List available commands
default:
    @just --list

# Build the packaged app (produces installer in app/release/)
build:
    {{pwsh}} -NoProfile -Command "cd C:\Users\raikr\Documents\projs\murmur\trunk\app; bun run package:win"

# Silently install the app
install:
    {{pwsh}} -NoProfile -Command "Get-Item 'C:\Users\raikr\Documents\projs\murmur\trunk\app\release\Murmur Setup*.exe' | ForEach-Object { Start-Process -Wait -FilePath \$_.FullName -ArgumentList '/S' }"

# Silently uninstall the app
uninstall:
    {{pwsh}} -NoProfile -Command "Start-Process -Wait -FilePath \"\$env:LOCALAPPDATA\\Programs\\Murmur\\Uninstall Murmur.exe\" -ArgumentList '/S'"
