"""Focused tests for hosted Retained History acceptance lane safety guards,
rejection logic, SQLite schema validation, and CDP probe mechanisms.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(os.name != 'nt', reason='Windows lifecycle harness')


def ps_literal(value):
    """Encode a path or string as one literal PowerShell argument."""
    return "'" + str(value).replace("'", "''") + "'"


def test_powershell_literal_preserves_apostrophes_and_metacharacters(tmp_path):
    """Read a real fixture whose path would otherwise terminate a generated literal."""
    path = tmp_path / "O'Brien $fixture.txt"
    path.write_text('fictional fixture', encoding='utf-8')
    command = f"Get-Content -LiteralPath {ps_literal(path.as_posix())} -Raw"
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == 'fictional fixture'


@pytest.mark.parametrize('exit_code', [0, 17])
def test_owned_exit_requires_success_from_retained_process(tmp_path, exit_code):
    """Exercise the real process handle after exit, including a recycled PID lookup."""
    command = f"""
$ErrorActionPreference = 'Stop'
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
function Write-Step {{ param($Message) }}
function Stop-OwnedHistoryProcess {{ throw 'Unexpected forced cleanup' }}
$process = Start-Process pwsh -ArgumentList @('-NoProfile', '-Command', 'exit {exit_code}') -PassThru -WindowStyle Hidden
$null = $process.Handle
$info = [pscustomobject]@{{ Id = $process.Id; CreationTicks = $process.StartTime.ToUniversalTime().Ticks; Process = $process }}
$process.WaitForExit()
function Get-Process {{ return $null }}
Wait-ForOwnedProcessExit -ProcInfo $info -TimeoutSeconds 2
"""
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15)
    if exit_code:
        assert result.returncode != 0
        assert 'nonzero or unavailable exit code' in result.stderr
    else:
        assert result.returncode == 0, result.stdout + result.stderr


def test_owned_exit_timeout_stops_live_child():
    """A live child must hit the bounded timeout and be cleaned up before failure."""
    command = f"""
$ErrorActionPreference = 'Stop'
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
function Write-Step {{ param($Message) }}
$script:child = Start-Process pwsh -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden
$null = $script:child.Handle
$script:stopped = $false
function Stop-OwnedHistoryProcess {{
    $script:child.Kill()
    $script:child.WaitForExit()
    $script:stopped = $true
}}
try {{
    if ($script:child.HasExited) {{ throw 'Child was not live before wait' }}
    $info = [pscustomobject]@{{ Id=$script:child.Id; Process=$script:child }}
    $failure = $null
    try {{ Wait-ForOwnedProcessExit -ProcInfo $info -TimeoutSeconds 1 }}
    catch {{ $failure = $_.Exception.Message }}
    if ($failure -notlike '*did not exit gracefully*') {{ throw 'Expected graceful-exit timeout failure' }}
    if (-not $script:stopped -or -not $script:child.HasExited) {{ throw 'Live child cleanup was not established' }}
}} finally {{
    if (-not $script:child.HasExited) {{ $script:child.Kill(); $script:child.WaitForExit() }}
    $script:child.Dispose()
}}
"""
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stdout + result.stderr


def test_probe_accepts_json_stdout_with_stderr_warning(tmp_path):
    tmp_path = tmp_path / "O'Brien probe"
    tmp_path.mkdir()
    scripts = tmp_path / 'scripts'
    scripts.mkdir()
    (scripts / 'retained-history-probe.mjs').write_text(
        'console.error("benign warning");\n'
        'console.log(JSON.stringify({status:"passed",closeRequested:true}));\n',
        encoding='utf-8',
    )
    command = f"""
$ErrorActionPreference = 'Stop'
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
$script:RepoRoot = {ps_literal(tmp_path.as_posix())}
function Write-Step {{ param($Message) }}
$result = Invoke-RetainedHistoryProbe -CdpPort 12345 -Phase fixture -InstallDir fixture -ExpectationsPath fixture
if ($result.status -ne 'passed') {{ throw 'Probe result lost' }}
"""
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr


def test_staging_stops_before_copy_when_release_verifier_exits_nonzero(tmp_path):
    scripts = tmp_path / 'scripts'
    scripts.mkdir()
    (scripts / 'release-artifacts.ps1').write_text('exit 1\n', encoding='utf-8')
    retained = tmp_path / 'retained'
    retained.mkdir()
    (retained / 'fixture.txt').write_text('fixture', encoding='utf-8')
    candidate = tmp_path / 'candidate'
    candidate.mkdir()
    digest = hashlib.sha256(b'fixture').hexdigest()
    command = f"""
$ErrorActionPreference = 'Stop'
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
$script:RepoRoot = {ps_literal(tmp_path.as_posix())}
function Get-RetainedCandidatePins {{
    return @{{ Files = @{{ 'fixture.txt' = '{digest}' }}; CandidateVersion = 'fixture'; CandidateCommit = 'fixture'; ManifestSha256 = 'fixture' }}
}}
function Copy-Item {{ throw 'COPY_REACHED' }}
Assert-RetainedCandidateStaging -RetainedDir {ps_literal(retained.as_posix())} -CandidateArtifactDir {ps_literal(candidate.as_posix())}
"""
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert 'Retained candidate release verification failed' in result.stderr
    assert 'COPY_REACHED' not in result.stderr
    assert not list(candidate.iterdir())


@pytest.mark.parametrize('field,value,message', [
    ('target_commitish', '0' * 40, 'release identity or state differs'),
    ('draft', True, 'release identity or state differs'),
    ('asset_digest', 'sha256:' + '0' * 64, 'asset metadata differs from its pin: latest.yml'),
])
def test_candidate_download_rejects_release_drift_before_download(tmp_path, field, value, message):
    """Published release metadata that drifts from the pins must stop before any asset download."""
    release = {
        'id': 429752581, 'draft': False, 'prerelease': True, 'tag_name': 'v0.8.2-alpha.9',
        'target_commitish': 'b557f7dd772923d35612bde5d32bf8d9103ef42d',
        'assets': [
            {'name': 'Eve.Web.Setup.0.8.2-alpha.9.exe', 'id': 694519593, 'size': 654633, 'state': 'uploaded',
             'digest': 'sha256:debfc43d275c947e4065586baf76d0a0d7acb10cd1fa5c16296396e3fd7cedef'},
            {'name': 'latest.yml', 'id': 694519592, 'size': 596, 'state': 'uploaded',
             'digest': 'sha256:df110ec1a628c119a654c01580fa4122d7de27389bd22b1f669a414104f00225'},
            {'name': 'murmur-0.8.2-alpha.9-x64.nsis.7z', 'id': 695103834, 'size': 212196890, 'state': 'uploaded',
             'digest': 'sha256:5908c899bc2caffe48b95c920d23d660be5227c45b844b92d01dfc81347f164c'},
            {'name': 'eve-v0.8.2-alpha.9-artifact-manifest.json', 'id': 694519594, 'size': 2019, 'state': 'uploaded',
             'digest': 'sha256:e180604fd9e59bbbe8ca6adb0929b2762883115ba908e30e74e421aaddab61ab'},
            {'name': 'THIRD_PARTY_NOTICES.txt', 'id': 694519739, 'size': 9510, 'state': 'uploaded',
             'digest': 'sha256:8b8359ccb1f406e734da60a4783d46c32d7255a4ffa0b3407be67602039b2b41'},
            {'name': 'SHA256SUMS.txt', 'id': 694519606, 'size': 368, 'state': 'uploaded',
             'digest': 'sha256:317b2e889f59f11a9982cc5234c245cf07acd017055e0964064fb2e330d7363e'},
            {'name': 'SHA512SUMS.txt', 'id': 694519700, 'size': 624, 'state': 'uploaded',
             'digest': 'sha256:81250d76e975f32fa155694290983e815841fb6e5c30fe114eb4ab55d6092c53'},
        ],
    }
    if field == 'asset_digest':
        release['assets'][1]['digest'] = value
    else:
        release[field] = value
    release_json = tmp_path / 'release.json'
    release_json.write_text(json.dumps(release), encoding='utf-8')
    runner_temp = tmp_path / 'runner'
    runner_temp.mkdir()
    target = runner_temp / 'retained'
    command = f"""
$ErrorActionPreference = 'Stop'
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
$env:RUNNER_TEMP = {ps_literal(runner_temp)}
function gh {{ $global:LASTEXITCODE = 0; Get-Content -LiteralPath {ps_literal(release_json)} -Raw }}
function curl.exe {{ throw 'DOWNLOAD_REACHED' }}
Save-RetainedHistoryCandidate -RetainedDir {ps_literal(target)}
"""
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode != 0
    assert message in result.stderr, result.stdout + result.stderr
    assert 'DOWNLOAD_REACHED' not in result.stderr
    assert not list(target.iterdir())


def test_scripts_parse_and_ast_intact():
    """Verify that installer-lifecycle-ci.ps1 and retained-history-ci.ps1 parse without errors."""
    for script_name in ['scripts/installer-lifecycle-ci.ps1', 'scripts/retained-history-ci.ps1']:
        script_path = ROOT / script_name
        assert script_path.exists()
        cmd = [
            'pwsh', '-NoProfile', '-Command',
            f"$tokens = $null; $errors = $null; "
            f"[System.Management.Automation.Language.Parser]::ParseFile({ps_literal(script_path.as_posix())}, [ref]$tokens, [ref]$errors); "
            f"if ($errors.Count) {{ throw $errors[0].Message }}"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        assert res.returncode == 0, res.stdout + res.stderr


def test_history_mode_binds_candidate_version_before_installer_paths():
    """A newer harness release must still consume the pinned alpha.9 candidate."""
    command = f"""
$ErrorActionPreference = 'Stop'
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
$ast = [System.Management.Automation.Language.Parser]::ParseFile({ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}, [ref]$null, [ref]$null)
$fn = $ast.Find({{ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-RetainedHistoryCi' }}, $true)
$bindings = @($fn.Body.EndBlock.Statements | Where-Object {{
    $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $_.Left.VariablePath.UserPath -eq 'script:CandidateVersion'
}})
if ($bindings.Count -ne 1) {{ throw 'Expected one retained candidate version binding' }}
$script:CandidateVersion = '0.8.2-alpha.10'
Invoke-Expression $bindings[0].Extent.Text
if ($script:CandidateVersion -cne '0.8.2-alpha.9') {{ throw 'Retained version inherited harness release' }}
$installer = $fn.Body.EndBlock.Statements | Where-Object {{
    $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
    $_.Left.VariablePath.UserPath -eq 'candidateInstaller'
}}
if ($bindings[0].Extent.StartOffset -ge $installer.Extent.StartOffset) {{ throw 'Version binding follows installer path' }}
"""
    result = subprocess.run(['pwsh', '-NoProfile', '-Command', command],
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize('runner,event,message', [
    ('github-hosted', 'pull_request', 'workflow_dispatch manual trigger'),
    ('self-hosted', 'workflow_dispatch', 'disposable GitHub-hosted Windows runner'),
])
def test_host_guard_rejects_non_hosted_or_wrong_event(tmp_path, runner, event, message):
    """Reject each invalid host or event independently with otherwise valid context."""
    test_script = tmp_path / 'test_host.ps1'
    test_script.write_text(f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. {ps_literal(ROOT / 'scripts/installer-candidate-artifacts.ps1')}
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}

$env:GITHUB_ACTIONS = 'true'
$env:RUNNER_ENVIRONMENT = '{runner}'
$env:OS = 'Windows_NT'
$env:GITHUB_EVENT_NAME = '{event}'
$env:GITHUB_REF = 'refs/heads/trunk'
$env:RUNNER_TEMP = {ps_literal(tmp_path.as_posix())}
$env:GITHUB_WORKSPACE = {ps_literal(ROOT.as_posix())}
$env:GITHUB_SHA = '555e303092ddd18f14c7a29723acaa4806c3f2e1'

Assert-RetainedHistoryCiHost -ExpectedCommit $env:GITHUB_SHA -RepoRoot {ps_literal(ROOT.as_posix())}
""", encoding='utf-8')

    res = subprocess.run(['pwsh', '-NoProfile', '-File', str(test_script)], capture_output=True, text=True, timeout=15)
    assert res.returncode != 0
    assert message in res.stderr


def test_host_guard_rejects_non_trunk_ref(tmp_path):
    """Prove that Assert-RetainedHistoryCiHost rejects branches other than trunk."""
    test_script = tmp_path / 'test_ref.ps1'
    test_script.write_text(f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. {ps_literal(ROOT / 'scripts/installer-candidate-artifacts.ps1')}
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}

$env:GITHUB_ACTIONS = 'true'
$env:RUNNER_ENVIRONMENT = 'github-hosted'
$env:OS = 'Windows_NT'
$env:GITHUB_EVENT_NAME = 'workflow_dispatch'
$env:GITHUB_REF = 'refs/heads/feature-branch' # WRONG: must be refs/heads/trunk
$env:RUNNER_TEMP = {ps_literal(tmp_path.as_posix())}
$env:GITHUB_WORKSPACE = {ps_literal(ROOT.as_posix())}
$env:GITHUB_SHA = '555e303092ddd18f14c7a29723acaa4806c3f2e1'

Assert-RetainedHistoryCiHost -ExpectedCommit $env:GITHUB_SHA -RepoRoot {ps_literal(ROOT.as_posix())}
""", encoding='utf-8')

    res = subprocess.run(['pwsh', '-NoProfile', '-File', str(test_script)], capture_output=True, text=True, timeout=15)
    assert res.returncode != 0
    assert 'restricted to trunk' in res.stderr


def test_retained_staging_rejects_missing_or_corrupt_files(tmp_path):
    """Prove that Assert-RetainedCandidateStaging rejects missing or tampered candidate files."""
    retained_dir = tmp_path / 'retained'
    retained_dir.mkdir()
    candidate_dir = tmp_path / 'candidate'
    candidate_dir.mkdir()

    # Call with empty retained dir -> missing files
    test_script = tmp_path / 'test_missing.ps1'
    test_script.write_text(f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. {ps_literal(ROOT / 'scripts/installer-manifest.ps1')}
. {ps_literal(ROOT / 'scripts/installer-candidate-artifacts.ps1')}
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
function Write-Step {{ param($Message) }}

Assert-RetainedCandidateStaging -RetainedDir {ps_literal(retained_dir.as_posix())} -CandidateArtifactDir {ps_literal(candidate_dir.as_posix())}
""", encoding='utf-8')

    res = subprocess.run(['pwsh', '-NoProfile', '-File', str(test_script)], capture_output=True, text=True, timeout=15)
    assert res.returncode != 0
    assert 'Retained candidate file allowlist mismatch' in res.stderr


def test_retained_staging_rejects_hash_mismatch(tmp_path):
    """Prove that Assert-RetainedCandidateStaging rejects files with incorrect SHA-256."""
    retained_dir = tmp_path / 'retained'
    retained_dir.mkdir()
    qa_dir = retained_dir / 'qa'
    qa_dir.mkdir()
    candidate_dir = tmp_path / 'candidate'
    candidate_dir.mkdir()

    # Create dummy files with wrong contents
    for name in [
        'Eve.Web.Setup.0.8.2-alpha.9.exe', 'murmur-0.8.2-alpha.9-x64.nsis.7z',
        'eve-v0.8.2-alpha.9-artifact-manifest.json', 'latest.yml',
        'THIRD_PARTY_NOTICES.txt', 'SHA256SUMS.txt', 'SHA512SUMS.txt'
    ]:
        (retained_dir / name).write_text('corrupt', encoding='utf-8')
    (qa_dir / 'candidate-payload-manifest.json').write_text('corrupt', encoding='utf-8')

    test_script = tmp_path / 'test_corrupt.ps1'
    test_script.write_text(f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. {ps_literal(ROOT / 'scripts/installer-manifest.ps1')}
. {ps_literal(ROOT / 'scripts/installer-candidate-artifacts.ps1')}
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
function Write-Step {{ param($Message) }}

Assert-RetainedCandidateStaging -RetainedDir {ps_literal(retained_dir.as_posix())} -CandidateArtifactDir {ps_literal(candidate_dir.as_posix())}
""", encoding='utf-8')

    res = subprocess.run(['pwsh', '-NoProfile', '-File', str(test_script)], capture_output=True, text=True, timeout=15)
    assert res.returncode != 0
    assert 'Retained candidate hash mismatch' in res.stderr


def test_sqlite_seeder_validates_schema_and_inserts_fictional_records(tmp_path):
    """Prove that Invoke-HistoryDatabaseSeed validates schema and seeds records accurately."""
    db_path = tmp_path / 'history.db'
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE transcriptions (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            text TEXT NOT NULL,
            confidence REAL,
            audioDuration REAL,
            transcriptionTime INTEGER,
            wordCount INTEGER,
            sessionMode TEXT,
            engine TEXT,
            model TEXT,
            device TEXT,
            computeType TEXT,
            cudaActive INTEGER,
            editedAt INTEGER,
            originalText TEXT
        );
    """)
    conn.commit()
    conn.close()

    test_script = tmp_path / 'test_seed.ps1'
    test_script.write_text(f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
function Write-Step {{ param($Message) }}

$manifest = Invoke-HistoryDatabaseSeed -DbPath {ps_literal(db_path.as_posix())}
Write-Output "SEEDED_COUNT=$($manifest.seededRowCount)"
""", encoding='utf-8')

    res = subprocess.run(['pwsh', '-NoProfile', '-File', str(test_script)], capture_output=True, text=True, timeout=15)
    assert res.returncode == 0, res.stdout + res.stderr
    assert 'SEEDED_COUNT=3' in res.stdout

    # Verify rows in sqlite
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("SELECT id, text, wordCount FROM transcriptions ORDER BY timestamp ASC;")
    rows = cur.fetchall()
    conn.close()
    assert len(rows) == 3
    assert rows[0][0] == 'fixture-hist-001'
    assert rows[1][0] == 'fixture-hist-002-delete'
    assert rows[2][0] == 'fixture-hist-003'


def test_sqlite_seeder_rejects_missing_table_or_columns(tmp_path):
    """Prove that Invoke-HistoryDatabaseSeed rejects a database missing the transcriptions table."""
    db_path = tmp_path / 'empty.db'
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE other_table (id TEXT);")
    conn.commit()
    conn.close()

    test_script = tmp_path / 'test_bad_schema.ps1'
    test_script.write_text(f"""
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. {ps_literal(ROOT / 'scripts/retained-history-ci.ps1')}
function Write-Step {{ param($Message) }}

Invoke-HistoryDatabaseSeed -DbPath {ps_literal(db_path.as_posix())}
""", encoding='utf-8')

    res = subprocess.run(['pwsh', '-NoProfile', '-File', str(test_script)], capture_output=True, text=True, timeout=15)
    assert res.returncode != 0
    assert "Table 'transcriptions' not found" in res.stderr


def test_cdp_probe_target_selection():
    """Prove that selectMainTarget selects the app renderer and rejects overlay or non-page targets."""
    probe_script = ROOT / 'scripts/retained-history-probe.mjs'
    check_js = f"""
import {{ selectMainTarget }} from '{probe_script.as_uri()}';

const targets = [
  {{ id: '1', type: 'page', title: 'Overlay', url: 'file:///C:/Eve/resources/renderer/overlay/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/1' }},
  {{ id: '2', type: 'page', title: 'Eve', url: 'file:///C:/Eve/resources/renderer/app/index.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2' }},
  {{ id: '3', type: 'background_page', title: 'Background', url: '', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/3' }}
];

const selected = selectMainTarget(targets,'file:///C:/Eve/resources/renderer/app/index.html',9222);
if (selected.id !== '2') {{
  throw new Error(`Expected target 2, got ${{selected.id}}`);
}}
console.log('TARGET_SELECTION_OK');
"""
    res = subprocess.run(['node', '--input-type=module', '-e', check_js], capture_output=True, text=True, timeout=15)
    assert res.returncode == 0, res.stdout + res.stderr
    assert 'TARGET_SELECTION_OK' in res.stdout


def test_cdp_probe_privacy_hashing():
    """Prove that probe sha256 computes correct digest and aggregates without leaking plain text."""
    probe_script = ROOT / 'scripts/retained-history-probe.mjs'
    check_js = f"""
import {{ sha256 }} from '{probe_script.as_uri()}';

const text = 'alpha functional history baseline entry one';
const hash = sha256(text);
const expected = '{hashlib.sha256("alpha functional history baseline entry one".encode("utf-8")).hexdigest()}';
if (hash !== expected) {{
  throw new Error(`Hash mismatch: expected ${{expected}}, got ${{hash}}`);
}}
console.log('HASH_OK');
"""
    res = subprocess.run(['node', '--input-type=module', '-e', check_js], capture_output=True, text=True, timeout=15)
    assert res.returncode == 0, res.stdout + res.stderr
    assert 'HASH_OK' in res.stdout


def test_probe_rejects_wrong_application_and_remote_debugger():
    probe = (ROOT / 'scripts/retained-history-probe.mjs').as_uri()
    code = f"""
import assert from 'node:assert/strict';
import {{selectMainTarget}} from '{probe}';
const expected='file:///C:/QA/Eve/resources/app.asar/dist/renderer/app/index.html';
const target={{id:'1',type:'page',title:'Eve',url:expected,webSocketDebuggerUrl:'ws://127.0.0.1:9222/devtools/page/1'}};
assert.equal(selectMainTarget([target],expected,9222).id,'1');
for(const change of [{{url:'https://example.invalid/app/index.html'}},{{url:'file:///C:/Other/app/index.html'}},{{webSocketDebuggerUrl:'ws://example.invalid:9222/devtools/page/1'}}]) {{
 assert.throws(()=>selectMainTarget([{{...target,...change}}],expected,9222));
}}
"""
    res = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True, text=True, timeout=15)
    assert res.returncode == 0, res.stdout + res.stderr


def test_probe_rejects_missing_changed_or_duplicate_history():
    probe = (ROOT / 'scripts/retained-history-probe.mjs').as_uri()
    code = f"""
import assert from 'node:assert/strict';
import {{assertHistoryResponse,sha256}} from '{probe}';
const row={{id:'fictional-1',timestamp:123,text:'fictional canary'}};
const expected=[{{id:row.id,timestamp:123,textHash:sha256(row.text)}}];
assertHistoryResponse({{entries:[row],hasMore:false}},expected);
for(const entries of [[],[{{...row,text:'changed'}}],[row,row],[{{...row,timestamp:124}}]]) {{
 assert.throws(()=>assertHistoryResponse({{entries,hasMore:false}},expected));
}}
assert.throws(()=>assertHistoryResponse({{entries:[row],hasMore:true}},expected));
"""
    res = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True, text=True, timeout=15)
    assert res.returncode == 0, res.stdout + res.stderr


@pytest.mark.parametrize('mode', ['success', 'verification-failure', 'settings-failure', 'sentinels-failure', 'baseline-initialize', 'baseline-read',
    'candidate-upgrade-read-mutate', 'candidate-relaunch-verify', 'baseline-rollback-read', 'cleanup-failure'])
def test_real_history_sequence_never_passes_failed_observation(tmp_path, mode):
    res = subprocess.run(['pwsh', '-NoProfile', '-File',
        str(ROOT / 'server/tests/fixtures/retained-history-sequence.ps1'),
        '-Source', str(ROOT / 'scripts/retained-history-ci.ps1'), '-Root', str(tmp_path), '-Mode', mode],
        capture_output=True, text=True, timeout=20)
    assert res.returncode == 0, res.stdout + res.stderr
    assert f'SEQUENCE_PROOF={mode}' in res.stdout


@pytest.mark.parametrize('phase,appearance,mismatch,rejection', [
    ('baseline-read', None, False, None),
    ('candidate-relaunch-verify', 'light', False, None),
    ('candidate-relaunch-verify', 'dark', False, 'Saved appearance did not persist'),
    ('baseline-rollback-read', None, False, None),
    ('baseline-rollback-read', 'light', False, 'Baseline unexpectedly reports appearance'),
    ('baseline-read', None, True, 'History records changed, duplicated or missing'),
])
def test_real_observer_checks_history_and_appearance_persistence(phase, appearance, mismatch, rejection):
    """Observe History without Settings and reject lost saved appearance after restart.

    The pinned alpha.5 baseline predates the appearance setting, so its fixture omits it.
    """
    settings = {'serverAutoStart': False, 'startMinimized': False}
    if appearance is not None:
        settings['appearance'] = appearance
    probe = (ROOT / 'scripts/retained-history-probe.mjs').as_uri()
    code = f"""
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {{observeHistory,sha256}} from '{probe}';
const rows=[{{id:'first',timestamp:2,text:'fictional first'}},{{id:'second',timestamp:1,text:'fictional second'}}];
const expected=rows.map(r=>({{id:r.id,timestamp:r.timestamp,textHash:sha256(r.text)}}));
const apiRows={json.dumps(mismatch)} ? rows.map(r=>({{...r,text:'changed API fixture'}})) : rows;
let navigated=false;
const historyButton={{click(){{navigated=true;}}}};
const settingsButton={{textContent:'Settings'}};
const document={{
 querySelector(s){{if(s==='button[data-view="history"]')return historyButton;
   if(s==='input[type="search"]')return navigated?{{}}:null;return null;}},
 querySelectorAll(s){{if(s==='button')return [historyButton,settingsButton];
   if(s!=={json.dumps('[data-history-entry] .entry-text' if phase.startswith('candidate-') else 'button[aria-expanded] > p:first-of-type')})return [];
   return rows.map(r=>({{textContent:r.text,closest:()=>null,getBoundingClientRect:()=>({{width:20,height:10}})}}));}}
}};
const window={{murmurMain:{{getAppVersion:()=> '{"0.8.2-alpha.9" if phase.startswith("candidate-") else "0.8.2-alpha.5"}',
 getSettings:()=>({json.dumps(settings)}),getServerStatus:()=>({{status:'idle'}}),
 getHistoryEntries:(offset,limit)=>({{entries:apiRows.slice(offset,offset+limit),hasMore:offset+limit<apiRows.length}})}}}};
const observe=()=>observeHistory({{evaluate:expression=>Promise.resolve(vm.runInNewContext(expression,{{window,document}}))}},'{phase}',expected);
if ({json.dumps(rejection)}) {{
 await assert.rejects(observe,new RegExp({json.dumps(rejection)}));
}} else {{
 const result=await observe();
 assert.equal(result.renderedCount,2);assert.equal(result.settingsMounted,false);assert.ok(navigated);
 assert.deepEqual(result.records,expected);
}}
"""
    res = subprocess.run(['node', '--input-type=module', '-e', code], capture_output=True, text=True, timeout=20)
    assert res.returncode == 0, res.stdout + res.stderr


def test_upgrade_observer_uses_search_control_and_requires_seeded_appearance():
    """Exercise the actual observer against DOM input events and IPC mutations."""
    probe = (ROOT / 'scripts/retained-history-probe.mjs').as_uri()
    code = f"""
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {{observeHistory,sha256}} from '{probe}';
const initial=[{{id:'fixture-hist-003',timestamp:3,text:'gamma baseline'}},
 {{id:'fixture-hist-002-delete',timestamp:2,text:'beta temporary'}},
 {{id:'fixture-hist-001',timestamp:1,text:'alpha baseline'}}];
const expected=initial.map(r=>({{id:r.id,timestamp:r.timestamp,textHash:sha256(r.text)}}));
async function exercise(appearance, filterRows=true) {{
 let rows=[...initial], navigated=false, searched=false;
 const settings={{serverAutoStart:false,startMinimized:false,appearance}};
 const input={{value:'',dispatchEvent(event){{assert.equal(event.type,'input');assert.ok(event.bubbles);searched=true;}}}};
 const document={{querySelector(s){{if(s==='button[data-view="history"]')return {{click(){{navigated=true;}}}};
   if(s==='input[type="search"]')return navigated?input:null;return null;}},
   querySelectorAll(s){{if(s!=='[data-history-entry] .entry-text')return [];
    return rows.filter(r=>!searched||!filterRows||r.text.includes(input.value)).map(r=>({{
    textContent:r.text,closest:()=>null,getBoundingClientRect:()=>({{width:20,height:10}})}}));}}}};
 const window={{murmurMain:{{getAppVersion:()=> '0.8.2-alpha.9',getSettings:()=>({{...settings}}),
  getServerStatus:()=>({{status:'idle'}}),getHistoryEntries:(offset,limit,filters)=>{{
   const selected=rows.filter(r=>!filters?.text||r.text.includes(filters.text));
   return {{entries:selected.slice(offset,offset+limit),hasMore:offset+limit<selected.length}};}},
  updateSetting:(key,value)=>{{settings[key]=value;}},deleteHistoryEntry:id=>{{rows=rows.filter(r=>r.id!==id);}}}}}};
 const session={{evaluate:expression=>Promise.resolve(vm.runInNewContext(expression,{{window,document,Event}}))}};
 const result=await observeHistory(session,'candidate-upgrade-read-mutate',expected);
 assert.ok(searched);assert.equal(input.value,'baseline');assert.ok(result.searchControlVerified);
 assert.equal(settings.appearance,'light');assert.equal(rows.length,2);
}}
await exercise('dark');
await assert.rejects(exercise('light'),/Seeded appearance was not read/);
await assert.rejects(exercise('dark',false),/Packaged app observation timed out/);
"""
    result = subprocess.run(['node', '--input-type=module', '-e', code],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize('unexpected_transcript', [False, True])
def test_baseline_initialize_accepts_empty_legacy_history_only(unexpected_transcript):
    """Ignore empty-state copy but reject any visible transcript in the published baseline layout."""
    probe = (ROOT / 'scripts/retained-history-probe.mjs').as_uri()
    code = f"""
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {{observeHistory}} from '{probe}';
// Input contract from v0.8.2-alpha.5 HistoryView.svelte.
const legacyInput={{type:'text',label:'Search transcriptions'}};
const paragraph=text=>({{textContent:text,closest:()=>null,getBoundingClientRect:()=>({{width:20,height:10}})}});
const transcripts={json.dumps(unexpected_transcript)}?[paragraph('unexpected fictional transcript')]:[];
let navigated=false;
const historyButton={{textContent:'History',click(){{navigated=true;}}}};
const document={{
 querySelector(selector){{
  if(selector==='input[type="text"][aria-label="Search transcriptions"]' && navigated)return legacyInput;
  return null;
 }},
 querySelectorAll(selector){{
  if(selector==='button')return [historyButton];
  if(selector==='p')return [paragraph('Empty-state hint'),...transcripts];
  if(selector==='button[aria-expanded] > p:first-of-type')return transcripts;
  return [];
 }}
}};
const window={{murmurMain:{{getAppVersion:()=> '0.8.2-alpha.5',
 getSettings:()=>({{serverAutoStart:false,startMinimized:false,appearance:'dark'}}),
 getServerStatus:()=>({{status:'idle'}}),getHistoryEntries:()=>({{entries:[],hasMore:false}})}}}};
const observe=()=>observeHistory({{evaluate:expression=>Promise.resolve(vm.runInNewContext(expression,{{window,document}}))}},'baseline-initialize',[]);
if({json.dumps(unexpected_transcript)}){{await assert.rejects(observe,/Packaged app observation timed out/);}}
else{{const result=await observe();assert.equal(result.renderedCount,0);assert.equal(result.settingsMounted,false);}}
assert.ok(navigated);
"""
    result = subprocess.run(['node', '--input-type=module', '-e', code],
                            capture_output=True, text=True, timeout=25)
    assert result.returncode == 0, result.stdout + result.stderr
