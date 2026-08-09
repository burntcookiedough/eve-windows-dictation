import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  calculateDropdownPosition,
  findFirstEnabledIndex,
  findLastEnabledIndex,
  findNextEnabledIndex,
  findTypeaheadIndex,
} from '../src/renderer/app/components/eve-dropdown';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const primaryPage = source('../src/renderer/app/components/PrimaryPage.svelte');
const dropdown = source('../src/renderer/app/components/EveDropdown.svelte');
const dropdownHelpers = source('../src/renderer/app/components/eve-dropdown.ts');
const appCss = source('../src/renderer/app/app.css');
const home = source('../src/renderer/app/views/HomeView.svelte');
const history = source('../src/renderer/app/views/HistoryView.svelte');
const insights = source('../src/renderer/app/views/InsightsView.svelte');
const settings = source('../src/renderer/app/views/SettingsView.svelte');
const layoutFixture = source('../src/renderer/app/fixtures/SettingsLayoutFixture.svelte');
const speechFixture = source('../src/renderer/app/fixtures/SettingsSpeechFixture.svelte');

const options = [
  { label: 'Alpha' },
  { label: 'Beta', disabled: true },
  { label: 'Gamma' },
  { label: 'Delta' },
];

describe('shared primary-page and dropdown foundation', () => {
  test('gives every primary page the same outer geometry and one page scroll owner', () => {
    for (const view of [home, history, insights, settings]) {
      expect(view).toContain("import PrimaryPage from '../components/PrimaryPage.svelte'");
      expect(view).toContain('<PrimaryPage');
    }
    expect(primaryPage).toContain('data-primary-page-content');
    expect(primaryPage).toContain('max-w-4xl');
    expect(primaryPage).toContain('overflow-x-hidden overflow-y-auto overscroll-contain');
    expect(primaryPage).toContain('[scrollbar-gutter:stable]');
    expect(primaryPage).toContain('data-scroll-owner={scrollOwner}');
    expect(appCss).toMatch(/html,\s*body,\s*#app\s*\{[\s\S]*?overflow: hidden;/);
    expect(history).not.toContain('flex-1 overflow-y-auto');
    expect(insights).not.toContain('flex-1 overflow-y-auto');
    expect(insights).toContain("document.querySelector<HTMLDivElement>('[data-scroll-owner=\"insights\"]')");
  });

  test('keeps the production palette neutral and reserves color for semantic state/focus cues', () => {
    expect(appCss).toContain('--eve-surface-0: #08090a;');
    expect(appCss).toContain('--eve-focus: #f4f4f5;');
    expect(appCss).toContain('--eve-status-success: #86efac;');
    expect(appCss).toContain('--eve-status-warning: #fcd34d;');
    expect(appCss).toContain('--eve-status-error: #fca5a5;');
    expect(home).not.toMatch(/\b(?:sky|violet|purple|cyan)-/);
    expect(history).not.toMatch(/\b(?:blue|sky|violet|purple|cyan)-/);
    expect(dropdown).not.toMatch(/\b(?:blue|sky|cyan|violet|purple)-/);
    expect(dropdown).toContain('focus-visible:ring-zinc-100');
  });

  test('covers accessible dropdown semantics and interaction ownership in one reusable component', () => {
    expect(settings).not.toContain('<select');
    expect(layoutFixture).not.toContain('<select');
    expect(speechFixture).not.toContain('<select');
    expect(dropdown).toContain('role="combobox"');
    expect(dropdown).toContain('role="listbox"');
    expect(dropdown).toContain('role="option"');
    expect(dropdown).toContain('aria-activedescendant');
    expect(dropdown).toContain('aria-disabled={option.disabled || undefined}');
    expect(dropdown).toContain('aria-describedby={option.description ?');
    expect(dropdown).toContain('disabled={option.disabled}');
    expect(dropdown).toContain('if (!option || option.disabled) return;');
    expect(dropdown).toContain("event.key === 'Enter' || event.key === ' '");
    expect(dropdown).toContain("event.key === 'Tab'");
    expect(dropdown).toContain('document.addEventListener(\'pointerdown\'');
    expect(dropdown).toContain('findTypeaheadIndex');
    expect(dropdown).toContain('calculateDropdownPosition');
    expect(dropdown).toContain('button?.focus({ preventScroll: true })');
  });

  test('moves through enabled options and wraps typeahead deterministically', () => {
    expect(findFirstEnabledIndex(options)).toBe(0);
    expect(findLastEnabledIndex(options)).toBe(3);
    expect(findNextEnabledIndex(options, 0, 1)).toBe(2);
    expect(findNextEnabledIndex(options, 2, 1)).toBe(3);
    expect(findNextEnabledIndex(options, 3, 1)).toBe(0);
    expect(findNextEnabledIndex(options, 0, -1)).toBe(3);
    expect(findTypeaheadIndex(options, 'ga')).toBe(2);
    expect(findTypeaheadIndex(options, 'a', 0)).toBe(0);
    expect(findTypeaheadIndex(options, 'd', 2)).toBe(3);
    expect(findTypeaheadIndex(options, 'missing')).toBe(-1);
  });

  test('constrains the listbox to the viewport and flips above near the bottom edge', () => {
    const below = calculateDropdownPosition({
      top: 80,
      bottom: 116,
      left: 900,
      width: 160,
      viewportWidth: 1024,
      viewportHeight: 768,
      optionCount: 3,
    });
    expect(below.placement).toBe('below');
    expect(below.left + below.width).toBeLessThanOrEqual(1016);
    expect(below.top).toBeGreaterThanOrEqual(0);
    expect(below.top + below.maxHeight).toBeLessThanOrEqual(768);

    const above = calculateDropdownPosition({
      top: 700,
      bottom: 736,
      left: 4,
      width: 240,
      viewportWidth: 320,
      viewportHeight: 768,
      optionCount: 12,
    });
    expect(above.placement).toBe('above');
    expect(above.left).toBeGreaterThanOrEqual(8);
    expect(above.left + above.width).toBeLessThanOrEqual(312);
    expect(above.top + above.maxHeight).toBeLessThanOrEqual(700);
  });

  test('keeps helper and component contracts together so behavior cannot drift', () => {
    expect(dropdown).toContain("import {");
    expect(dropdown).toContain("from './eve-dropdown'");
    expect(dropdownHelpers).toContain('export function findTypeaheadIndex');
    expect(dropdownHelpers).toContain('export function calculateDropdownPosition');
  });
});
