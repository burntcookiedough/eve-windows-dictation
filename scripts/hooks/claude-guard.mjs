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
        (_, single, double) => single ?? double.replace(/\\"/g, '"')));
    }
  }
  if (words.length) yield words;
}

function isTrunk(ref) {
  return ref === 'trunk' || ref === 'refs/heads/trunk';
}

function isTagListing(operands) {
  let list = false;
  let hasPattern = false;
  for (let index = 0; index < operands.length; index++) {
    const arg = operands[index];
    if (arg === '--') {
      hasPattern ||= index < operands.length - 1;
      break;
    }
    if (/^-(?:l|l?n\d*)$/.test(arg) || arg === '--list') {
      list = true;
    } else if (arg === '--sort' || arg.startsWith('--sort=')) {
      // A descending sort key starts with a dash, such as -version:refname.
      if (arg === '--sort') index++;
    } else if (/^--(?:contains|points-at)(?:=|$)/.test(arg)) {
      list = true;
      if (!arg.includes('=') && operands[index + 1] && !operands[index + 1].startsWith('-')) {
        index++;
      }
    } else if (arg.startsWith('-')) {
      return false;
    } else {
      hasPattern = true;
    }
  }
  return list || !hasPattern;
}

function commandName(program) {
  return program.split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, '');
}

function blockedOperation(words, cwd, context) {
  const [program, ...args] = words;
  const executable = commandName(program);
  if (['cd', 'set-location', 'pushd'].includes(executable)) {
    context.changed = true;
    return;
  }
  if (executable === 'gh') {
    const release = args.indexOf('release');
    if (release !== -1 && ['create', 'upload', 'delete', 'edit'].includes(args[release + 1])) {
      return 'GitHub release changes are reserved for the release owner.';
    }
    return;
  }
  if (executable !== 'git') return;

  const globalArgs = [];
  while (args[0]?.startsWith('-')) {
    const flag = args.shift();
    globalArgs.push(flag);
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag) && args.length) {
      globalArgs.push(args.shift());
    }
  }
  const [operation, ...operands] = args;
  const contextChangedBeforeCommand = context.changed;
  if (globalArgs.includes('-C') || operation === 'switch'
    || (operation === 'checkout' && operands[0] !== '--')) {
    context.changed = true;
  }
  if (operation === 'tag' && !isTagListing(operands)) {
    return 'Git tag changes are reserved for the release owner.';
  }
  if (operation !== 'push' && operation !== 'reset') return;

  if (operation === 'push') {
    if (operands.some((arg) => /^--force(-|$)/.test(arg) || /^-[^-]*f/.test(arg) || arg.startsWith('+'))) {
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
    if (branchRefs.some((ref) => ref === ':' || ref.includes('*'))) {
      return 'Matching or wildcard refspecs can update trunk. Push a specific topic branch.';
    }
    if (branchRefs.some((ref) => isTrunk(ref.split(':').at(-1)))) {
      return 'Pushes to trunk are blocked. Open a pull request from a topic branch.';
    }
    if (refs.length && !branchRefs.includes('HEAD')) return;
  } else if (!operands.includes('--hard')) {
    return;
  } else if (contextChangedBeforeCommand) {
    return 'Run git reset --hard as its own command after changing branches or directories.';
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

function findBlockedOperation(command, cwd, context = { changed: false }) {
  for (const tokens of shellCommands(command)) {
    let start = 0;
    while (start < tokens.length) {
      const token = tokens[start];
      if (!/^[A-Za-z_]\w*=/.test(token) && token !== '--'
        && !['env', 'sudo', 'command', 'exec'].includes(commandName(token))) break;
      start++;
    }
    const words = tokens.slice(start);
    if (!words.length) continue;

    const [program, ...args] = words;
    const executable = commandName(program);
    let commandFlag = -1;
    if (executable === 'bash' || executable === 'sh') {
      commandFlag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    } else if (executable === 'cmd') {
      commandFlag = args.findIndex((arg) => arg.toLowerCase() === '/c');
    } else if (executable === 'powershell' || executable === 'pwsh') {
      commandFlag = args.findIndex((arg) => /^-(?:c|command)$/i.test(arg));
    }
    const nestedArgs = commandFlag === -1 ? [] : args.slice(commandFlag + 1);
    const script = ['bash', 'sh'].includes(executable) || nestedArgs.length < 2
      ? nestedArgs[0]
      : nestedArgs.join(' ');
    const message = script
      ? findBlockedOperation(script, cwd, context)
      : blockedOperation(words, cwd, context);
    if (message) return message;
  }
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input.tool_input?.command;
  if (typeof command === 'string') {
    const message = findBlockedOperation(command, input.cwd);
    if (message) {
      console.error(message);
      process.exitCode = 2;
    }
  }
} catch {
  console.error('Claude Code Git guard could not read the hook input.');
  process.exitCode = 2;
}
