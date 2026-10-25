"""Exercise production byte verification and archive policy without installing an app."""
import json
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]


def run_ps(command, **values):
    env = dict(os.environ, HELPER=str(ROOT / 'scripts/installer-manifest.ps1'))
    env.update({key: str(value) for key, value in values.items()})
    return subprocess.run(
        ['pwsh', '-NoProfile', '-Command',
         "$ErrorActionPreference='Stop'; . $env:HELPER; " + command],
        env=env, capture_output=True, text=True, timeout=30,
    )


@pytest.fixture
def payload(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'nested').mkdir()
    (source / 'nested' / 'helper.exe').write_bytes(b'synthetic')
    (source / 'empty.txt').touch()
    manifest = tmp_path / 'manifest.json'
    result = run_ps('New-InstalledPayloadManifest $env:SOURCE $env:MANIFEST', SOURCE=source, MANIFEST=manifest)
    assert result.returncode == 0, result.stderr
    return source, manifest


def verify(source, manifest):
    return run_ps('Assert-InstalledPayload $env:SOURCE $env:MANIFEST', SOURCE=source, MANIFEST=manifest)


def test_manifest_verifies_all_files(payload):
    source, manifest = payload
    data = json.loads(manifest.read_text(encoding='utf-8'))
    assert data['fileCount'] == 2
    assert {entry['path'] for entry in data['files']} == {'empty.txt', 'nested/helper.exe'}
    assert verify(source, manifest).returncode == 0


def test_relative_manifest_output_uses_powershell_location(payload, tmp_path):
    source, _ = payload
    working = tmp_path / 'powershell-location'
    process_directory = tmp_path / 'process-directory'
    working.mkdir()
    process_directory.mkdir()
    result = run_ps(
        'Set-Location -LiteralPath $env:WORKING; '
        '[Environment]::CurrentDirectory=$env:PROCESS_DIRECTORY; '
        "New-InstalledPayloadManifest $env:SOURCE 'relative.json'",
        SOURCE=source, WORKING=working, PROCESS_DIRECTORY=process_directory,
    )
    assert result.returncode == 0, result.stderr
    assert (working / 'relative.json').is_file()
    assert not (process_directory / 'relative.json').exists()


@pytest.mark.parametrize('change,expected', [('missing', 'Missing'), ('length', 'length mismatch'), ('hash', 'SHA256 mismatch')])
def test_detects_lost_or_changed_bytes(payload, change, expected):
    source, manifest = payload
    target = source / 'nested' / 'helper.exe'
    if change == 'missing':
        target.unlink()
    else:
        target.write_bytes(b'x' if change == 'length' else b'SYNTHETIC')
    result = verify(source, manifest)
    assert result.returncode != 0
    assert expected in result.stderr


@pytest.mark.parametrize('change', ['schema', 'count', 'empty', 'duplicate', 'traversal', 'absolute', 'ads', 'length', 'hash'])
def test_rejects_invalid_manifest(payload, change):
    source, manifest = payload
    data = json.loads(manifest.read_text(encoding='utf-8'))
    entry = data['files'][0]
    if change == 'schema':
        data['schemaVersion'] = 99
    elif change == 'count':
        data['fileCount'] += 1
    elif change == 'empty':
        data.update(files=[], fileCount=0)
    elif change == 'duplicate':
        data['files'][1] = entry
    elif change in {'traversal', 'absolute', 'ads'}:
        entry['path'] = {'traversal': '../outside', 'absolute': 'C:/outside', 'ads': 'file:stream'}[change]
    elif change == 'length':
        entry['length'] = 0.5
    else:
        entry['sha256'] = 'z' * 64
    manifest.write_text(json.dumps(data), encoding='utf-8')
    assert verify(source, manifest).returncode != 0


@pytest.mark.parametrize('listing,valid', [
    ('Path = helper.exe\nSize = 5\nMethod = BCJ LZMA2:20', True),
    ('Path = helper.exe\nSize = 5\nMethod = BCJ LZMA2:3m', True),
    ('Path = helper.exe\nSize = 5\nMethod = LZMA2:1536k', True),
    ('Path = stored.bin\nSize = 5\nMethod = Copy', True),
    ('Path = empty.txt\nSize = 0\nMethod = ', True),
    ('Path = file\nSize = 5\nMethod = ARM64 LZMA2:20', False),
    ('Path = file\nSize = 5\nMethod = BCJ2 LZMA2:20', False),
    ('Path = file\nSize = 5\nMethod = ', False),
    ('Path = file\nSize = 5', False),
    ('', False),
    ('Path = directory\nFolder = +', False),
    ('Path = directory\nAttributes = D\nSize = 0\nMethod = ', False),
])
def test_archive_listing_fails_closed(listing, valid):
    result = run_ps('Assert-SevenZipListing -Listing $env:LISTING', LISTING=listing)
    assert (result.returncode == 0) == valid, result.stderr


def test_archive_native_failure_is_rejected(tmp_path):
    archive = tmp_path / 'bad.7z'
    archive.write_bytes(b'invalid archive')
    # PowerShell itself is a real executable that rejects the 7-Zip arguments.
    result = run_ps('Assert-SevenZipArchiveMethods -ArchivePath $env:ARCHIVE -SevenZipPath (Get-Command pwsh).Source', ARCHIVE=archive)
    assert result.returncode != 0
    assert 'listing failed' in result.stderr


@pytest.mark.skipif(os.name != 'nt', reason='Windows executable discovery')
def test_pinned_resolver_precedes_path_and_path_remains_fallback(tmp_path):
    app = tmp_path / 'app'
    module = app / 'node_modules/app-builder-lib/out/toolsets/7zip.js'
    module.parent.mkdir(parents=True)
    module.write_text('exports.getPath7za = async () => process.execPath;', encoding='utf-8')
    path_tool = tmp_path / '7z.exe'
    path_tool.write_bytes(b'lookup-only fixture, never executed')
    command = 'Resolve-SevenZip -AppDir $env:APP'
    values = {'APP': app, 'PATH': str(tmp_path) + os.pathsep + os.environ['PATH']}
    pinned = run_ps(command, **values)
    assert pinned.returncode == 0, pinned.stderr
    assert 'node.exe' in pinned.stdout.lower()
    module.write_text('exports.getPath7za = async () => null;', encoding='utf-8')
    fallback = run_ps(command, **values)
    assert fallback.returncode == 0, fallback.stderr
    assert str(path_tool) in fallback.stdout


@pytest.mark.skipif(os.name != 'nt', reason='Windows directory junction')
def test_manifest_generation_rejects_directory_junction(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    (source / 'visible.txt').write_bytes(b'visible')
    other = tmp_path / 'other'
    other.mkdir()
    (other / 'omitted.txt').write_bytes(b'must not silently omit')
    result = run_ps(
        "New-Item -ItemType Junction -Path (Join-Path $env:SOURCE 'linked') -Target $env:OTHER | Out-Null; "
        'New-InstalledPayloadManifest $env:SOURCE $env:MANIFEST',
        SOURCE=source, OTHER=other, MANIFEST=tmp_path / 'manifest.json',
    )
    assert result.returncode != 0
    assert 'reparse points are unsupported' in result.stderr


def test_skip_launch_still_verifies_requested_bytes(payload):
    source, manifest = payload
    (source / 'Eve.exe').write_bytes(b'synthetic exe, never launched')
    smoke = (ROOT / 'scripts/installer-smoke.ps1').read_text(encoding='utf-8')
    # Execute the real post-install block only; never invoke installers or cleanup.
    block = smoke[smoke.index('$exePath = Join-Path $InstallDir'):smoke.index('$launchStartedAt =')]
    assert 'if ($SkipLaunch)' in block
    command = (
        '$InstallDir=$env:SOURCE; $ManifestPath=$env:MANIFEST; $SkipLaunch=$true; '
        'function Write-Step { param($Message) Write-Host $Message }; ' + block
    )
    valid = run_ps(command, SOURCE=source, MANIFEST=manifest)
    assert valid.returncode == 0, valid.stderr
    assert 'Skipping launch' in valid.stdout
    (source / 'nested/helper.exe').unlink()
    missing = run_ps(command, SOURCE=source, MANIFEST=manifest)
    assert missing.returncode != 0
    assert 'Missing installed payload' in missing.stderr
