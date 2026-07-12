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
  const safeLeft = Math.max(displayBounds.x, workArea.x);
  const safeRight = Math.min(
    displayBounds.x + displayBounds.width,
    workArea.x + workArea.width
  );
  const safeWidth = Math.max(1, safeRight - safeLeft);
  const sideMargin = Math.min(OVERLAY_SIDE_MARGIN, Math.floor((safeWidth - 1) / 2));
  const availableWidth = Math.max(1, safeWidth - sideMargin * 2);
  const width = Math.min(preferredWidth, availableWidth);
  const minX = safeLeft;
  const maxX = safeRight - width;
  const centeredX = safeLeft + Math.round((safeWidth - width) / 2);
  const x = Math.max(minX, Math.min(centeredX, maxX));

  const maxY = workArea.y + workArea.height - height;
  const preferredY = workArea.y + workArea.height - height - bottomMargin;
  const y = Math.max(workArea.y, Math.min(preferredY, maxY));

  return { x, y, width, height };
}
