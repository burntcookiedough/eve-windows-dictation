import { MAIN_WINDOW_CONFIG } from '../../shared/constants.js';
import type { WindowBounds } from '../../shared/types.js';

export interface DisplayWorkArea {
  id: number;
  workArea: Pick<WindowBounds, 'x' | 'y' | 'width' | 'height'>;
}

type WindowPosition = Pick<WindowBounds, 'x' | 'y'>;
type WindowSize = Pick<WindowBounds, 'width' | 'height'>;

function intersectionArea(bounds: WindowBounds, workArea: DisplayWorkArea['workArea']): number {
  const width = Math.max(
    0,
    Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x)
  );
  const height = Math.max(
    0,
    Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y)
  );
  return width * height;
}

function fittedSize(workArea: DisplayWorkArea['workArea']): WindowSize {
  const ratioUnit = Math.floor(
    Math.min(
      MAIN_WINDOW_CONFIG.WIDTH / 2,
      MAIN_WINDOW_CONFIG.HEIGHT / 3,
      workArea.width / 2,
      workArea.height / 3
    )
  );

  return {
    width: ratioUnit * 2,
    height: ratioUnit * 3,
  };
}

function findMatchingDisplay(
  position: WindowPosition,
  size: WindowSize,
  displays: readonly DisplayWorkArea[]
): DisplayWorkArea | undefined {
  const probe = { ...position, ...size };
  let match: DisplayWorkArea | undefined;
  let largestIntersection = 0;

  for (const display of displays) {
    const area = intersectionArea(probe, display.workArea);
    if (area > largestIntersection) {
      match = display;
      largestIntersection = area;
    }
  }

  return match;
}

export function fitMainWindowBounds(
  savedPosition: WindowPosition | undefined,
  displays: readonly DisplayWorkArea[],
  primaryDisplayId: number,
  matchingSize: WindowSize = { width: MAIN_WINDOW_CONFIG.WIDTH, height: MAIN_WINDOW_CONFIG.HEIGHT }
): WindowBounds {
  if (displays.length === 0) {
    throw new Error('At least one display work area is required to position the main window.');
  }

  const primary = displays.find((display) => display.id === primaryDisplayId) ?? displays[0]!;
  const matched = savedPosition ? findMatchingDisplay(savedPosition, matchingSize, displays) : undefined;
  const display = matched ?? primary;
  const { workArea } = display;
  const { width, height } = fittedSize(workArea);
  const hasValidSavedPosition = Boolean(savedPosition && matched);
  const preferredX = hasValidSavedPosition ? savedPosition!.x : workArea.x + Math.floor((workArea.width - width) / 2);
  const preferredY = hasValidSavedPosition ? savedPosition!.y : workArea.y + Math.floor((workArea.height - height) / 2);

  return {
    x: Math.min(Math.max(preferredX, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(preferredY, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}
