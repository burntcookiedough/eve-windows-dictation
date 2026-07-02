import { describe, expect, test } from 'bun:test';
import { OVERLAY_CONFIG } from '../src/shared/constants.js';
import { calculateOverlayBounds } from '../src/main/windows/overlay-bounds.js';

describe('calculateOverlayBounds', () => {
  test('centers the preferred quick overlay inside a normal work area', () => {
    expect(
      calculateOverlayBounds(
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1040 },
        OVERLAY_CONFIG.QUICK_WIDTH,
        OVERLAY_CONFIG.HEIGHT,
        OVERLAY_CONFIG.BOTTOM_MARGIN
      )
    ).toEqual({
      x: 610,
      y: 640,
      width: 700,
      height: 320,
    });
  });

  test('shrinks long overlay width so it cannot extend off a narrow display', () => {
    const bounds = calculateOverlayBounds(
      { x: 0, y: 0, width: 800, height: 800 },
      { x: 0, y: 0, width: 800, height: 760 },
      OVERLAY_CONFIG.LONG_WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds).toEqual({
      x: 16,
      y: 360,
      width: 768,
      height: 320,
    });
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(800);
  });

  test('clamps position within offset and vertically constrained work areas', () => {
    const bounds = calculateOverlayBounds(
      { x: -1280, y: 0, width: 640, height: 360 },
      { x: -1280, y: 40, width: 640, height: 300 },
      OVERLAY_CONFIG.LONG_WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds.x).toBe(-1264);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(-640);
    expect(bounds.y).toBe(40);
  });

  test('centers horizontally against full display bounds when work area is reserved', () => {
    const bounds = calculateOverlayBounds(
      { x: 0, y: 0, width: 2048, height: 1067 },
      { x: 256, y: 0, width: 1792, height: 1067 },
      OVERLAY_CONFIG.QUICK_WIDTH,
      OVERLAY_CONFIG.HEIGHT,
      OVERLAY_CONFIG.BOTTOM_MARGIN
    );

    expect(bounds.x).toBe(674);
    expect(bounds.x + bounds.width / 2).toBe(1024);
  });
});
