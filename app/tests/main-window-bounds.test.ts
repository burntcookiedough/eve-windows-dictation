import { describe, expect, test } from 'bun:test';
import { fitMainWindowBounds, type DisplayWorkArea } from '../src/main/windows/main-window-bounds';

const display = (id: number, x: number, y: number, width: number, height: number): DisplayWorkArea => ({
  id,
  workArea: { x, y, width, height },
});

describe('main window work-area fitting', () => {
  test('uses the preferred logical size and centers it on a desktop or portrait display', () => {
    expect(fitMainWindowBounds(undefined, [display(1, 0, 0, 1920, 1080)], 1)).toEqual({
      x: 660, y: 90, width: 600, height: 900,
    });
    expect(fitMainWindowBounds(undefined, [display(1, 0, 0, 900, 1440)], 1)).toEqual({
      x: 150, y: 270, width: 600, height: 900,
    });
  });

  test('fits the usable laptop work area, keeps the 2:3 size, and uses DIP dimensions on high-DPI displays', () => {
    expect(fitMainWindowBounds(undefined, [display(1, 0, 0, 1366, 728)], 1)).toEqual({
      x: 441, y: 1, width: 484, height: 726,
    });
    expect(fitMainWindowBounds(undefined, [display(1, 0, 0, 768, 1152)], 1)).toEqual({
      x: 84, y: 126, width: 600, height: 900,
    });
  });

  test('shrinks proportionally when a small work area cannot fit the preferred size', () => {
    expect(fitMainWindowBounds(undefined, [display(1, 0, 0, 320, 500)], 1)).toEqual({
      x: 0, y: 10, width: 320, height: 480,
    });
  });

  test('preserves negative-coordinate position on a connected display and centers on primary after removal', () => {
    const primary = display(1, 0, 0, 1920, 1080);
    const left = display(2, -1280, 80, 1280, 900);
    expect(fitMainWindowBounds({ x: -900, y: 150 }, [primary, left], 1)).toEqual({
      x: -900, y: 80, width: 600, height: 900,
    });
    expect(fitMainWindowBounds({ x: -3000, y: 150 }, [primary], 1)).toEqual({
      x: 660, y: 90, width: 600, height: 900,
    });
  });

  test('ignores oversized saved dimensions and clamps only the saved position', () => {
    const savedBounds = { x: 1700, y: 800, width: 5000, height: 4000 };
    expect(fitMainWindowBounds(savedBounds, [display(1, 0, 0, 1920, 1080)], 1)).toEqual({
      x: 1320, y: 180, width: 600, height: 900,
    });
  });

  test('refits to the display with the most of the current window after a monitor move', () => {
    const primary = display(1, 0, 0, 1920, 1080);
    const shorter = display(2, 1920, 0, 1920, 768);
    expect(fitMainWindowBounds({ x: 1700, y: 50 }, [primary, shorter], 1, {
      width: 600,
      height: 900,
    })).toEqual({
      x: 1920, y: 0, width: 512, height: 768,
    });
  });
});
