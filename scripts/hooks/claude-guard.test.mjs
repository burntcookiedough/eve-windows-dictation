import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./claude-guard.mjs', import.meta.url));

function runGuard(cwd, command) {
  return spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ cwd, tool_input: { command } }),
    encoding: 'utf8',
  });
}

test('blocks protected operations and allows topic-branch work', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'eve-claude-guard-'));
  try {
    const init = spawnSync('git', ['init', '--initial-branch=trunk', cwd], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    for (const command of [
      'git push --force origin feature/example',
      'git push -uf origin feature/example',
      'git push origin +HEAD:feature/example',
      'git push -o ci.skip origin trunk',
      'git push --repo=origin HEAD:refs/heads/trunk',
      'git push origin --delete trunk',
      'git push origin --mirror',
      'git push',
      'git push origin HEAD',
      'git.exe reset --hard HEAD',
      'git status && git tag v0.1',
      'git -c core.quotePath=false tag v0.1',
      '& "C:\\Program Files\\Git\\cmd\\git.exe" push origin "HEAD:trunk"',
      'gh release create v0.1',
      'gh release upload v0.1 asset',
      'gh release delete v0.1',
      'gh release edit v0.1',
    ]) {
      const result = runGuard(cwd, command);
      assert.equal(result.status, 2, command);
      assert.ok(result.stderr.trim(), command);
    }

    const switchBranch = spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/topic/check'], {
      cwd, encoding: 'utf8',
    });
    assert.equal(switchBranch.status, 0, switchBranch.stderr);
    for (const command of [
      'git push -u origin HEAD',
      'git push origin trunk:review/trunk',
      'git push origin HEAD:feature/trunk',
      'git reset --hard HEAD',
      'gh release view',
      'echo "git push origin trunk"',
    ]) {
      assert.equal(runGuard(cwd, command).status, 0, command);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
