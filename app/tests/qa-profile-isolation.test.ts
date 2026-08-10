import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  EVE_QA_ISOLATION_SWITCH,
  EVE_QA_USER_DATA_ROOT_SWITCH,
  parseQaProfileIsolationArguments,
  resolveQaProfileIsolation,
} from '../src/main/qa-profile-isolation';

const QA_ROOT = String.raw`C:\qa\Roaming\Eve`;

function qaArguments(root = QA_ROOT): string[] {
  return [
    'Eve.exe',
    EVE_QA_ISOLATION_SWITCH,
    `${EVE_QA_USER_DATA_ROOT_SWITCH}=${root}`,
  ];
}

describe('packaged QA profile isolation arguments', () => {
  test('leaves normal launches unchanged', () => {
    expect(parseQaProfileIsolationArguments(['Eve.exe'])).toBeNull();
    expect(
      parseQaProfileIsolationArguments([
        'Eve.exe',
        `--user-data-dir=${String.raw`C:\pre-bootstrap`}`,
      ])
    ).toBeNull();
  });

  test('accepts exactly one explicit gate and case-insensitive Eve leaf', () => {
    expect(parseQaProfileIsolationArguments(qaArguments())).toBe(QA_ROOT);
    expect(
      parseQaProfileIsolationArguments(qaArguments(String.raw`C:\qa\Roaming\eve`))
    ).toBe(String.raw`C:\qa\Roaming\eve`);
  });

  test('resolves the canonical existing parent before bootstrap', () => {
    const requestedParent = String.raw`C:\qa\redirected-roaming`;
    const canonicalParent = String.raw`C:\qa\actual-roaming`;
    const resolved = resolveQaProfileIsolation(
      qaArguments(path.win32.join(requestedParent, 'Eve')),
      {
        stat: (value) => {
          expect(value).toBe(requestedParent);
          return { isDirectory: () => true };
        },
        realpath: (value) => {
          expect(value).toBe(requestedParent);
          return canonicalParent;
        },
      }
    );

    expect(resolved).toEqual({ appDataPath: canonicalParent });
  });

  test.each([
    ['missing gate', ['Eve.exe', `${EVE_QA_USER_DATA_ROOT_SWITCH}=${QA_ROOT}`]],
    ['missing root', ['Eve.exe', EVE_QA_ISOLATION_SWITCH]],
    [
      'duplicate gate',
      [
        ...qaArguments(),
        EVE_QA_ISOLATION_SWITCH,
      ],
    ],
    [
      'duplicate root',
      [
        ...qaArguments(),
        `${EVE_QA_USER_DATA_ROOT_SWITCH}=${QA_ROOT}`,
      ],
    ],
    [
      'alternate gate form',
      ['Eve.exe', '--eve-qa-isolation=true', `${EVE_QA_USER_DATA_ROOT_SWITCH}=${QA_ROOT}`],
    ],
    [
      'uppercase gate',
      ['Eve.exe', '--EVE-QA-ISOLATION', `${EVE_QA_USER_DATA_ROOT_SWITCH}=${QA_ROOT}`],
    ],
    [
      'mixed-case root switch',
      ['Eve.exe', EVE_QA_ISOLATION_SWITCH, `--eve-Qa-user-data-root=${QA_ROOT}`],
    ],
    [
      'separate root value',
      ['Eve.exe', EVE_QA_ISOLATION_SWITCH, EVE_QA_USER_DATA_ROOT_SWITCH, QA_ROOT],
    ],
    [
      'standard Electron root collision',
      [...qaArguments(), `--user-data-dir=${String.raw`C:\other`}`],
    ],
    [
      'standard Electron separate collision',
      [...qaArguments(), '--user-data-dir', String.raw`C:\other`],
    ],
    [
      'mixed-case Electron root collision',
      [...qaArguments(), `--UsEr-DaTa-DiR=${String.raw`C:\other`}`],
    ],
    ['relative root', qaArguments(String.raw`qa\Roaming\Eve`)],
    ['wrong leaf', qaArguments(String.raw`C:\qa\Roaming\NotEve`)],
    ['trailing separator', qaArguments(`${QA_ROOT}${path.win32.sep}`)],
    ['noncanonical traversal', qaArguments(String.raw`C:\qa\Roaming\other\..\Eve`)],
    ['unknown QA-looking switch', [...qaArguments(), '--eve-qa-unrelated']],
    ['uppercase unknown QA-looking switch', [...qaArguments(), '--EVE-QA-UNRELATED']],
  ])('fails closed for %s', (_name, argv) => {
    expect(() => parseQaProfileIsolationArguments(argv)).toThrow(
      /Invalid packaged QA profile arguments|QA user-data root/
    );
  });
});
