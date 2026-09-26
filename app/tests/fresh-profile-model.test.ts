import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { seedFreshCpuProfile } from '../src/main/fresh-profile-model';

const temporaryProfiles: string[] = [];

function profile(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'eve-fresh-model-'));
  temporaryProfiles.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryProfiles.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const packagedWindows = { freshProfile: true, packaged: true, platform: 'win32' as const };

describe('fresh packaged CPU model', () => {
  test('seeds small once before the first server launch', () => {
    const directory = profile();
    // Electron creates cache files after the validated root is marked fresh.
    writeFileSync(path.join(directory, 'Local State'), '{}');
    expect(seedFreshCpuProfile(directory, packagedWindows)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(directory, 'server-settings.json'), 'utf8'))).toEqual({
      whisper_model: 'small',
    });
    expect(seedFreshCpuProfile(directory, { ...packagedWindows, freshProfile: false })).toBe(false);
  });

  test('preserves an existing Eve profile whose old default was never persisted', () => {
    const directory = profile();
    writeFileSync(path.join(directory, 'history.db'), 'existing profile');
    expect(seedFreshCpuProfile(directory, { ...packagedWindows, freshProfile: false })).toBe(false);
    expect(readFileSync(path.join(directory, 'history.db'), 'utf8')).toBe('existing profile');
  });

  test('preserves an explicit saved model', () => {
    const directory = profile();
    const settingsPath = path.join(directory, 'server-settings.json');
    writeFileSync(settingsPath, '{"whisper_model":"large-v3-turbo"}\n');
    expect(seedFreshCpuProfile(directory, packagedWindows)).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"whisper_model":"large-v3-turbo"}\n');
  });

  test('does not seed development, other platforms, or an explicit model override', () => {
    for (const options of [
      { ...packagedWindows, packaged: false },
      { ...packagedWindows, platform: 'linux' as const },
      { ...packagedWindows, modelOverride: 'large-v3-turbo' },
    ]) {
      expect(seedFreshCpuProfile(profile(), options)).toBe(false);
    }
  });
});
