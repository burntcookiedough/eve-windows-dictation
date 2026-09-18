import { describe, expect, test } from 'bun:test';
import { normalizeModelCatalog } from '../src/main/services/server-settings';
import {
  hasPendingCompatibilityChanges,
  presetPatch,
  speechModelPresetsFromCatalog,
  stagedPresetFromPending,
} from '../src/renderer/app/speech-model-presets';
import type { ModelCatalogItem } from '../src/shared/types';

const catalog: ModelCatalogItem[] = [
  {
    model: 'custom-model',
    label: 'Custom model label',
    summary: 'Metadata supplied by the server.',
    repo_id: 'example/custom-model',
    size_gb: 0.75,
    language_label: 'English',
    languages: ['en'],
    supports_hotwords: true,
  },
];

describe('server-owned speech model catalog mapping', () => {
  test('derives preset identity and presentation from server metadata', () => {
    const [preset] = speechModelPresetsFromCatalog(catalog);

    expect(preset).toEqual({
      id: 'custom-model',
      label: 'Custom model label',
      model: 'custom-model',
      sizeGb: 0.75,
      language: 'English',
      summary: 'Metadata supplied by the server.',
    });
    expect(presetPatch(preset!)).toEqual({ whisper_model: 'custom-model' });
    expect(stagedPresetFromPending({ whisper_model: 'custom-model' }, [preset!])).toEqual(preset);
  });

  test('does not invent choices when an older server omits or empties the catalog', () => {
    expect(speechModelPresetsFromCatalog(undefined)).toEqual([]);
    expect(speechModelPresetsFromCatalog([])).toEqual([]);
    expect(stagedPresetFromPending({ whisper_model: 'large-v3-turbo' }, [])).toBeNull();
    expect(hasPendingCompatibilityChanges({ whisper_model: 'large-v3-turbo' }, null)).toBeTrue();
  });

  test('ignores malformed catalog entries without hiding raw compatibility controls', () => {
    expect(speechModelPresetsFromCatalog([
      ...catalog,
      { model: '', label: '', summary: '', repo_id: '', size_gb: -1, language_label: '', languages: [], supports_hotwords: true },
    ])).toHaveLength(1);
  });

  test('normalizes an older object-shaped response and preserves only safe entries', () => {
    expect(normalizeModelCatalog({ models: catalog })).toEqual(catalog);
    expect(normalizeModelCatalog({ models: [{ model: 'legacy-only' }] })).toEqual([]);
    expect(normalizeModelCatalog(undefined)).toEqual([]);
  });
});
