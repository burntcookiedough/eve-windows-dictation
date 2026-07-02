const OVERLAY_SIDE_MARGIN = 16;

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function calculateOverlayBounds(
  displayBounds: WorkArea,
  workArea: WorkArea,
  preferredWidth: number,
  height: number,
  bottomMargin: number
): { x: number; y: number; width: number; height: number } {
  const availableWidth = Math.max(1, displayBounds.width - OVERLAY_SIDE_MARGIN * 2);
  const width = Math.min(preferredWidth, availableWidth);
  const minX = displayBounds.x;
  const maxX = displayBounds.x + displayBounds.width - width;
  const centeredX = displayBounds.x + Math.round((displayBounds.width - width) / 2);
  const x = Math.max(minX, Math.min(centeredX, maxX));

  const maxY = workArea.y + workArea.height - height;
  const preferredY = workArea.y + workArea.height - height - bottomMargin;
  const y = Math.max(workArea.y, Math.min(preferredY, maxY));

  return { x, y, width, height };
}
