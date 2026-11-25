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
      'git push --force-with-lease origin feature/example',
      'git push --force-with-lease=refs/heads/feature/example origin feature/example',
      'git push --force-if-includes origin feature/example',
      'git push -uf origin feature/example',
      'env git push -f',
      'GIT_X=1 git push -f',
      'env GIT_X=1 sudo command exec git push -f',
      'bash -c "git push -f"',
      'bash -c "sh -c \\"git tag x\\""',
      'sh -c "git push -f"',
      'cmd /c git push -f',
      'powershell -c "git tag x"',
      'pwsh -Command git tag x',
      'git push origin +HEAD:feature/example',
      'git push -o ci.skip origin trunk',
      'git push --repo=origin HEAD:refs/heads/trunk',
      'git push origin --delete trunk',
      'git push origin --mirror',
      'git push',
      'git push origin HEAD',
      'git push origin @',
      'git.exe reset --hard HEAD',
      'git status && git tag v0.1',
      'git -c core.quotePath=false tag v0.1',
      'git tag -d v0.1',
      'git tag --list --force v0.1',
      'git tag --sort=refname v0.1',
      '& "C:\\Program Files\\Git\\cmd\\git.exe" push origin "HEAD:trunk"',
      'gh release create v0.1',
      'gh release upload v0.1 asset',
      'gh release delete v0.1',
      'gh release delete-asset v0.1 installer.exe --yes',
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
      'git push origin :',
      'git push origin "refs/heads/*:refs/heads/*"',
      'git push origin "*:*"',
      'git push --all origin',
      'git push --mirror origin',
    ]) {
      const result = runGuard(cwd, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /can update trunk/);
    }
    for (const command of [
      'git switch trunk && git reset --hard HEAD~1',
      'git checkout trunk; git reset --hard',
      'cd other && git reset --hard',
      'ChDiR other; git reset --hard',
      'SL other; git reset --hard',
      'Set-Location other; git reset --hard',
      'pushd other; git reset --hard',
      'Push-Location other; git reset --hard',
      'git -C other status && git reset --hard',
      'git switch trunk && bash -c "git reset --hard"',
    ]) {
      const result = runGuard(cwd, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /as its own command/);
    }
    for (const command of [
      'git switch trunk && git push origin HEAD',
      'git checkout trunk && git push origin @',
      'cd other && git push',
      'sl other; git push origin',
      'chdir other; git push origin topic/check',
      'Set-Location other; git push origin refs/heads/topic/check',
      'pushd other; git push origin HEAD',
      'Push-Location other; git push origin HEAD',
      'git -C other status && git push origin HEAD',
    ]) {
      const result = runGuard(cwd, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /Run git push as its own command/);
    }
    for (const command of [
      'git push origin --tags',
      'git push --follow-tags',
      'git push origin tag custom-release',
      'git push origin refs/tags/custom-release',
      'git push origin HEAD:refs/tags/custom-release',
      'git push origin v1.2.3',
      'git push origin HEAD:v1.2.3',
    ]) {
      const result = runGuard(cwd, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /Publishing Git tags/);
    }
    for (const command of [
      'git push',
      'git push origin',
      'git push -u origin HEAD',
      'git switch trunk && git push origin HEAD:refs/heads/topic/check',
      'git push origin HEAD:refs/heads/v1.2.3',
      'git push origin trunk:review/trunk',
      'git push origin HEAD:feature/trunk',
      'git reset --hard HEAD',
      'git -C . reset --hard HEAD',
      'git checkout -- source.txt && git reset --hard HEAD',
      'git tag',
      'git tag -l "v0.*"',
      'git tag --list "v0.*"',
      'git tag -n',
      'git tag -n3',
      'git tag --contains HEAD',
      'git tag --points-at=HEAD',
      'git tag --sort -version:refname',
      'git tag --list --sort=refname "v0.*"',
      'powershell -Command "git tag --list"',
      'gh release view',
      'gh release list',
      'gh release download v0.1',
      'echo "git push origin trunk"',
    ]) {
      assert.equal(runGuard(cwd, command).status, 0, command);
    }

    const git = (...args) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Guard fixture');
    git('update-ref', 'refs/tags/custom-release', 'HEAD');
    const tagPush = runGuard(cwd, 'git push origin custom-release');
    assert.equal(tagPush.status, 2);
    assert.match(tagPush.stderr, /Publishing Git tags/);
    git('update-ref', 'refs/heads/custom-release', 'HEAD');
    const ambiguousPush = runGuard(cwd, 'git push origin custom-release');
    assert.equal(ambiguousPush.status, 2);
    assert.match(ambiguousPush.stderr, /matches a branch and a tag/);
    assert.equal(runGuard(cwd, 'git push origin refs/heads/custom-release').status, 0);
    assert.equal(runGuard(cwd, 'git push origin topic/check').status, 0);

    git('remote', 'add', 'origin', '.');
    git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git('update-ref', 'refs/remotes/origin/topic/check', 'HEAD');
    git('branch', '--set-upstream-to=origin/trunk');
    const revParse = ['rev-parse', '--abbrev-ref', '--symbolic-full-name'];

    git('config', 'push.default', 'upstream');
    assert.equal(git(...revParse, '@{push}'), 'origin/trunk');
    for (const command of ['git push', 'git push origin']) {
      const result = runGuard(cwd, command);
      assert.equal(result.status, 2, command);
      assert.match(result.stderr, /push resolves to trunk/);
    }

    git('config', 'push.default', 'simple');
    assert.equal(git(...revParse, '@{upstream}'), 'origin/trunk');
    assert.notEqual(spawnSync('git', [...revParse, '@{push}'], { cwd }).status, 0);
    assert.match(runGuard(cwd, 'git push origin').stderr, /push resolves to trunk/);

    git('config', 'push.default', 'current');
    assert.equal(git(...revParse, '@{push}'), 'origin/topic/check');
    assert.equal(runGuard(cwd, 'git push origin').status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
