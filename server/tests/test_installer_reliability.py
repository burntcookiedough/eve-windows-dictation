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
    ('Path = empty.txt\nSize = 0\nMethod = ', True),
    ('Path = file\nSize = 5\nMethod = ARM64 LZMA2:20', False),
    ('Path = file\nSize = 5\nMethod = BCJ2 LZMA2:20', False),
    ('Path = file\nSize = 5\nMethod = ', False),
    ('Path = file\nSize = 5', False),
    ('', False),
    ('Path = directory\nFolder = +', False),
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
