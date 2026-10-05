import { expect, test } from 'bun:test';
import { hasVisibleNavigationBlocker } from '../src/renderer/app/navigation-shortcuts';

test('keeps number navigation usable with the always-mounted closed Settings sheet', () => {
  const closedSettingsDialog = {
    closest: (selector: string) => selector.includes('inert') ? { inertLayer: true } : null,
  };
  const openHotkeyDialog = { closest: () => null };
  const openDropdownListbox = { closest: () => null };
  const isVisible = (candidate: typeof closedSettingsDialog | typeof openHotkeyDialog | typeof openDropdownListbox) => candidate !== closedSettingsDialog;

  expect(hasVisibleNavigationBlocker([closedSettingsDialog], isVisible)).toBeFalse();
  expect(hasVisibleNavigationBlocker([closedSettingsDialog, openHotkeyDialog], isVisible)).toBeTrue();
  expect(hasVisibleNavigationBlocker([openDropdownListbox], isVisible)).toBeTrue();
});
