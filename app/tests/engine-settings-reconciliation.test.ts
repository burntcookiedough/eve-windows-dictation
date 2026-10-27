import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileModule } from 'svelte/compiler';
import ts from 'typescript';

// Run the production functions and their actual Svelte effect, with synthetic
// IPC and state boundaries. This does not mount SettingsView or open a mic.
interface ProbeState {
  serverSettings: Record<string, { value: unknown }> | null;
  pendingEngine: Record<string, unknown>;
  enginePreparationActive: boolean;
  enginePreparationRequested: boolean;
  engineApplyError: string;
  engineStatus: { status: string };
  refreshingCommittedSettings: boolean;
}
interface Probe {
  read(): Promise<boolean>;
  apply(): Promise<void>;
  revert(): void;
  confirm(): Promise<void>;
  status(value: object): void;
  stage(value: object): void;
  snapshot(): ProbeState;
  dispose(): void;
}
let createProbe: (ipc: object, initial?: object) => Probe;
let directory: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'eve-settings-reconciliation-'));
  const component = readFileSync(new URL('../src/renderer/app/views/SettingsView.svelte', import.meta.url), 'utf8');
  const script = component.split('<script lang="ts">')[1]!.split('</script>')[0]!;
  const source = ts.createSourceFile('settings.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['loadServerSettings', 'applyEngineSettings', 'revertEngineSettings',
    'finishEnginePreparation', 'confirmEnginePreparationStatus', 'refreshCommittedSettings']);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''));
  const effect = source.statements.find(node => ts.isExpressionStatement(node)
    && node.expression.getText(source).startsWith('$effect(')
    && node.getText(source).includes('shouldRefreshCommittedSettings('));
  if (!effect || functions.length < 5) throw new Error('Production confirmation flow not found');
  const helper = new URL('../src/renderer/app/engine-settings-transaction.ts', import.meta.url).href;
  const input = `
    import {enginePreparationPhase,engineSettingsPatchMatches,clearAppliedEngineSettings,shouldRefreshCommittedSettings} from '${helper}';
    export function createProbe(ipc, initial = {}) {
      const window = {murmurMain: ipc};
      let controls;
      const dispose = $effect.root(() => {
        let pendingEngine = $state(initial.pending ?? {whisper_model:'submitted'});
        let enginePreparationPatch = $state({whisper_model:'submitted'});
        let enginePreparationRequested = $state(initial.requested ?? true), enginePreparationActive = $state(initial.active ?? true);
        let enginePreparationObserved = $state(initial.observed ?? true);
        let engineApplying = $state(false), refreshingCommittedSettings = $state(false);
        let engineApplyError = $state(''), serverSettings = $state(null), modelCatalog = $state([]);
        let serverSettingsLoading = $state(false), serverConnected = $state(true);
        let serverSettingsRead = null;
        let engineStatus = $state({current:'whisper',status:'ready'});
        const sharedEngineStatus = $derived(engineStatus);
        const preparationFailed = $derived(enginePreparationPhase(sharedEngineStatus) === 'failed');
        ${functions.map(node => node.getText(source)).join('\n')}
        ${effect.getText(source)}
        controls = {
          read: loadServerSettings,
          apply: applyEngineSettings, revert: revertEngineSettings,
          confirm: confirmEnginePreparationStatus,
          status: value => {engineStatus = value;},
          stage: patch => {pendingEngine = {...pendingEngine,...patch};},
          snapshot: () => JSON.parse(JSON.stringify({pendingEngine,enginePreparationPatch,serverSettings,
            enginePreparationRequested,enginePreparationActive,enginePreparationObserved,
            engineApplyError,engineStatus,refreshingCommittedSettings})),
        };
      });
      return {...controls,dispose};
    }
  `;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(input);
  const compiled = compileModule(js, { filename: 'confirmation.svelte.js', generate: 'client', dev: false }).js.code
    .replaceAll('svelte/internal/client', import.meta.resolve('svelte/internal/client'));
  const output = join(directory, 'confirmation.mjs');
  writeFileSync(output, compiled);
  ({ createProbe } = await import(pathToFileURL(output).href));
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

const ready = { current: 'whisper', status: 'ready' };
const loading = { current: 'whisper', status: 'loading' };
const response = (model = 'submitted') => ({ settings: { whisper_model: { value: model } }, engine_status: ready });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a ready mismatch stops after one read and retains staged values for explicit retry', async () => {
  let reads = 0;
  let updates = 0;
  let matching = false;
  const probe = createProbe({
    getServerSettings: async () => {
      if (++reads > 4) return new Promise(() => {}); // Bound a broken reactive loop.
      return response(matching ? 'submitted' : 'other-client');
    },
    updateServerSettings: async () => { updates++; return { ...response(), reload_started: true, engine_status: loading }; },
  });
  try {
    await settle();
    expect(reads).toBe(1);
    expect(probe.snapshot().enginePreparationActive).toBeFalse();
    expect(probe.snapshot().engineApplyError).not.toBe('');
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
    matching = true;
    await probe.apply();
    probe.status(ready);
    await settle();
    expect(updates).toBe(1);
    expect(reads).toBe(2);
    expect(probe.snapshot().pendingEngine).toEqual({});
    expect(probe.snapshot().engineApplyError).toBe('');
  } finally { probe.dispose(); }
});

test.each(['read-failure', 'ready-mismatch'])('missed-loading confirmation releases flags after %s', async mode => {
  const probe = createProbe({ getServerSettings: async () => {
    if (mode === 'read-failure') throw new Error('Synthetic read failure');
    return response('other-client');
  } }, { observed: false });
  try {
    await probe.confirm();
    expect(probe.snapshot().enginePreparationActive).toBeFalse();
    expect(probe.snapshot().enginePreparationRequested).toBeFalse();
    expect(probe.snapshot().engineApplyError).not.toBe('');
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
  } finally { probe.dispose(); }
});

test('successful confirmation preserves edits staged while the read was in flight', async () => {
  let resolveRead!: (value: object) => void;
  const probe = createProbe({ getServerSettings: () => new Promise(resolve => { resolveRead = resolve; }) });
  try {
    await settle();
    probe.stage({ whisper_model: 'later-edit', whisper_language: 'fr' });
    resolveRead(response());
    await settle();
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'later-edit', whisper_language: 'fr' });
    expect(probe.snapshot().enginePreparationActive).toBeFalse();
    expect(probe.snapshot().engineApplyError).toBe('');
  } finally { probe.dispose(); }
});

test.each(['success', 'failure'])('terminal failure invalidates a late %s and prevents overlapping Apply or Revert', async outcome => {
  let resolveRead!: (value: object) => void;
  let rejectRead!: (error: Error) => void;
  let updates = 0;
  const probe = createProbe({
    getServerSettings: () => new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }),
    updateServerSettings: async () => { updates++; return { ...response(), reload_started: true, engine_status: loading }; },
  });
  try {
    await settle();
    probe.status({ current: 'whisper', status: 'error', message: 'Synthetic terminal failure' });
    await settle();
    await probe.apply();
    probe.revert();
    expect(updates).toBe(0);
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
    if (outcome === 'success') resolveRead(response());
    else rejectRead(new Error('Synthetic late read failure'));
    await settle();
    expect(probe.snapshot().engineStatus.status).toBe('error');
    expect(probe.snapshot().engineApplyError).toBe('Synthetic terminal failure');
    expect(probe.snapshot().refreshingCommittedSettings).toBeFalse();
  } finally { probe.dispose(); }
});

test('an automatic confirmation read failure stops and preserves the staged transaction', async () => {
  let reads = 0;
  const probe = createProbe({ getServerSettings: async () => { reads++; throw new Error('Synthetic offline'); } });
  try {
    await settle();
    await settle();
    expect(reads).toBe(1);
    expect(probe.snapshot().enginePreparationRequested).toBeFalse();
    expect(probe.snapshot().enginePreparationActive).toBeFalse();
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
    expect(probe.snapshot().engineApplyError).not.toBe('');
  } finally { probe.dispose(); }
});

test('a loading confirmation waits for a new ready transition before reading again', async () => {
  let reads = 0;
  const probe = createProbe({ getServerSettings: async () => ({
    ...response(), engine_status: ++reads === 1 ? loading : ready,
  }) });
  try {
    await settle();
    await settle();
    expect(reads).toBe(1);
    expect(probe.snapshot().enginePreparationActive).toBeTrue();
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
    probe.status(ready);
    await settle();
    expect(reads).toBe(2);
    expect(probe.snapshot().pendingEngine).toEqual({});
    expect(probe.snapshot().engineApplyError).toBe('');
  } finally { probe.dispose(); }
});

test('busy confirmation waits for the existing read before one fresh confirmation', async () => {
  let reads = 0;
  let resolveFirst!: (value: object) => void;
  const probe = createProbe({ getServerSettings: async () => {
    if (++reads === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return response();
  } }, { observed: false });
  try {
    const first = probe.read();
    const confirmation = probe.confirm();
    await settle();
    await settle();
    expect(reads).toBe(1);
    expect(probe.snapshot().enginePreparationActive).toBeTrue();
    expect(probe.snapshot().engineApplyError).toBe('');
    resolveFirst(response());
    await first;
    await confirmation;
    await settle();
    expect(reads).toBe(2);
    expect(probe.snapshot().pendingEngine).toEqual({});
    expect(probe.snapshot().engineApplyError).toBe('');
  } finally { probe.dispose(); }
});

test('terminal failure invalidates the ordinary read that deferred confirmation', async () => {
  let reads = 0;
  let resolveFirst!: (value: object) => void;
  const probe = createProbe({ getServerSettings: () => {
    reads++;
    return new Promise(resolve => { resolveFirst = resolve; });
  } }, { observed: true });
  try {
    const first = probe.read();
    const confirmation = probe.confirm();
    probe.status({ current: 'whisper', status: 'error', message: 'Synthetic failure while busy' });
    await settle();
    resolveFirst(response());
    await first;
    await confirmation;
    await settle();
    expect(reads).toBe(1);
    expect(probe.snapshot().engineStatus.status).toBe('error');
    expect(probe.snapshot().engineApplyError).toBe('Synthetic failure while busy');
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
  } finally { probe.dispose(); }
});

test('a failed busy read is followed by one fresh confirmation with its own failure result', async () => {
  let reads = 0;
  let rejectFirst!: (error: Error) => void;
  const probe = createProbe({ getServerSettings: () => {
    if (++reads > 1) return Promise.reject(new Error('Synthetic confirmation failure'));
    return new Promise((_resolve, reject) => { rejectFirst = reject; });
  } }, { observed: false });
  try {
    const first = probe.read();
    const confirmation = probe.confirm();
    expect(probe.snapshot().engineApplyError).toBe('');
    rejectFirst(new Error('Synthetic ordinary read failure'));
    await first;
    await confirmation;
    await settle();
    expect(reads).toBe(2);
    expect(probe.snapshot().enginePreparationActive).toBeFalse();
    expect(probe.snapshot().enginePreparationRequested).toBeFalse();
    expect(probe.snapshot().engineApplyError).not.toBe('');
    expect(probe.snapshot().pendingEngine).toEqual({ whisper_model: 'submitted' });
  } finally { probe.dispose(); }
});

test('Revert during an ordinary read refreshes current settings after that read settles', async () => {
  let reads = 0;
  let resolveFirst!: (value: object) => void;
  const probe = createProbe({ getServerSettings: async () => {
    if (++reads === 1) return new Promise(resolve => { resolveFirst = resolve; });
    return response('current-after-revert');
  } }, { active: false, requested: false, observed: false });
  try {
    const first = probe.read();
    probe.revert();
    resolveFirst(response('stale-before-revert'));
    await first;
    await settle();
    expect(reads).toBe(2);
    expect(probe.snapshot().pendingEngine).toEqual({});
    expect(probe.snapshot().serverSettings?.whisper_model?.value).toBe('current-after-revert');
  } finally { probe.dispose(); }
});
