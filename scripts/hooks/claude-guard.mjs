import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function* shellCommands(command) {
  const tokens = command.replace(/(?:\\|`)\r?\n/g, '')
    .match(/(?:'[^']*'|"(?:\\"|[^"])*"|[^\s;&|()'"{}])+|[\n;&|(){}]/g) ?? [];
  let words = [];
  for (const token of tokens) {
    if (/^[\n;&|(){}]$/.test(token)) {
      if (words.length) yield words;
      words = [];
    } else {
      words.push(token.replace(/'([^']*)'|"((?:\\"|[^"])*)"/g,
        (_, single, double) => single ?? double));
    }
  }
  if (words.length) yield words;
}

function isTrunk(ref) {
  return ref === 'trunk' || ref === 'refs/heads/trunk';
}

function blockedOperation(words, cwd) {
  const [program, ...args] = words;
  const executable = program.split(/[\\/]/).at(-1).toLowerCase();
  if (executable === 'gh' || executable === 'gh.exe') {
    const release = args.indexOf('release');
    if (release !== -1 && ['create', 'upload', 'delete', 'edit'].includes(args[release + 1])) {
      return 'GitHub release changes are reserved for the release owner.';
    }
    return;
  }
  if (executable !== 'git' && executable !== 'git.exe') return;

  const globalArgs = [];
  while (args[0]?.startsWith('-')) {
    const flag = args.shift();
    globalArgs.push(flag);
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag) && args.length) {
      globalArgs.push(args.shift());
    }
  }
  const [operation, ...operands] = args;
  if (operation === 'tag') return 'Git tag operations are reserved for the release owner.';
  if (operation !== 'push' && operation !== 'reset') return;

  if (operation === 'push') {
    if (operands.some((arg) => arg === '--force' || /^-[^-]*f/.test(arg) || arg.startsWith('+'))) {
      return 'Force pushes are blocked.';
    }
    if (operands.some((arg) => ['--all', '--branches', '--mirror'].includes(arg))) {
      return 'Pushing all refs can update trunk. Push a specific topic branch.';
    }
    const positional = [];
    let hasRemoteOption = false;
    for (let index = 0; index < operands.length; index++) {
      const arg = operands[index];
      if (arg === '--repo' || arg.startsWith('--repo=')) hasRemoteOption = true;
      if (['--repo', '-o', '--push-option', '--receive-pack', '--exec'].includes(arg)) {
        index++;
      } else if (!arg.startsWith('-')) {
        positional.push(arg);
      }
    }
    const refs = hasRemoteOption ? positional : positional.slice(1);
    const branchRefs = refs.filter((ref, index) => ref !== 'tag' && refs[index - 1] !== 'tag');
    if (branchRefs.some((ref) => isTrunk(ref.split(':').at(-1)))) {
      return 'Pushes to trunk are blocked. Open a pull request from a topic branch.';
    }
    if (refs.length && !branchRefs.includes('HEAD')) return;
  } else if (!operands.includes('--hard')) {
    return;
  }

  const branch = spawnSync(program, [...globalArgs, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 1000,
  });
  if (branch.status === 0 && isTrunk(branch.stdout.trim())) {
    return operation === 'push'
      ? 'Pushes to trunk are blocked. Open a pull request from a topic branch.'
      : 'Hard resets on trunk are blocked.';
  }
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input.tool_input?.command;
  if (typeof command === 'string') {
    for (const words of shellCommands(command)) {
      const message = blockedOperation(words, input.cwd);
      if (message) {
        console.error(message);
        process.exitCode = 2;
        break;
      }
    }
  }
} catch {
  console.error('Claude Code Git guard could not read the hook input.');
  process.exitCode = 2;
}
