import { describe, expect, test } from 'bun:test';
import { OVERLAY_CONFIG } from '../src/shared/constants.js';
import { calculateOverlayBounds } from '../src/main/windows/overlay-bounds.js';

describe('calculateOverlayBounds', () => {
  test('centers the pill window inside a normal work area', () => {
    expect(
      calculateOverlayBounds(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1040 },
        OVERLAY_CONFIG.WIDTH,
        OVERLAY_CONFIG.HEIGHT,
        OVERLAY_CONFIG.BOTTOM_MARGIN
      )
    ).toEqual({
      x: 800,
      y: 892,
      width: 320,
      height: 56,
    });
  });

  test('shrinks the window so it cannot extend off a narrow display', () => {
    const bounds = calculateOverlayBounds(
      { x: 0, y: 0, width: 300, height: 800 },
      { x: 0, y: 0, width: 300, height: 760 },
      OVERLAY_CONFIG.WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds).toEqual({
      x: 16,
      y: 612,
      width: 268,
      height: 56,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(300);
  });

  test('clamps position within offset and vertically constrained work areas', () => {
    const bounds = calculateOverlayBounds(
      { x: -1280, y: 0, width: 300, height: 120 },
      { x: -1280, y: 40, width: 300, height: 80 },
      OVERLAY_CONFIG.WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds.x).toBe(-1264);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(-980);
    expect(bounds.y).toBe(40);
  });

  test('centers horizontally inside the safe work area when space is reserved', () => {
    const bounds = calculateOverlayBounds(
      { x: 0, y: 0, width: 2048, height: 1067 },
      { x: 256, y: 0, width: 1792, height: 1067 },
      OVERLAY_CONFIG.WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds.x).toBe(992);
    expect(bounds.x + bounds.width / 2).toBe(1152);
  });

  test('stays clear of a wide left-docked taskbar on a narrow display', () => {
    const bounds = calculateOverlayBounds(
      { x: 0, y: 0, width: 500, height: 800 },
      { x: 200, y: 0, width: 300, height: 800 },
      OVERLAY_CONFIG.WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds).toEqual({
      x: 216,
      y: 652,
      width: 268,
      height: 56,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(200);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(500);
  });
});
