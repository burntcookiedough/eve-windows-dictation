export interface DropdownPositionInput {
  top: number;
  bottom: number;
  left: number;
  width: number;
  viewportWidth: number;
  viewportHeight: number;
  optionCount: number;
  optionHeight?: number;
  maxHeight?: number;
  viewportPadding?: number;
}

export interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

export function findNextEnabledIndex<T extends { disabled?: boolean }>(
  options: readonly T[],
  startIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;

  let index = startIndex;
  for (let count = 0; count < options.length; count += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function findFirstEnabledIndex<T extends { disabled?: boolean }>(options: readonly T[]): number {
  return options.findIndex((option) => !option.disabled);
}

export function findLastEnabledIndex<T extends { disabled?: boolean }>(options: readonly T[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function findTypeaheadIndex<T extends { label: string; disabled?: boolean }>(
  options: readonly T[],
  query: string,
  startIndex = -1,
): number {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || options.length === 0) return -1;

  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (startIndex + offset + options.length) % options.length;
    const option = options[index];
    if (!option?.disabled && option.label.toLocaleLowerCase().startsWith(normalized)) {
      return index;
    }
  }
  return -1;
}

export function calculateDropdownPosition(input: DropdownPositionInput): DropdownPosition {
  const padding = input.viewportPadding ?? 8;
  const optionHeight = input.optionHeight ?? 36;
  const requestedMaxHeight = input.maxHeight ?? 280;
  const availableWidth = Math.max(1, input.viewportWidth - padding * 2);
  const width = Math.min(Math.max(input.width, 176), availableWidth);
  const left = Math.min(
    Math.max(input.left, padding),
    Math.max(padding, input.viewportWidth - width - padding),
  );
  const desiredHeight = Math.min(
    requestedMaxHeight,
    Math.max(optionHeight, input.optionCount * optionHeight + padding),
  );
  const belowSpace = Math.max(1, input.viewportHeight - input.bottom - padding);
  const aboveSpace = Math.max(1, input.top - padding);
  const placement = belowSpace < Math.min(desiredHeight, optionHeight * 4) && aboveSpace > belowSpace
    ? 'above'
    : 'below';
  const availableHeight = placement === 'above' ? aboveSpace : belowSpace;
  const maxHeight = Math.max(1, Math.min(desiredHeight, availableHeight));
  const top = placement === 'above'
    ? Math.max(padding, input.top - maxHeight - 4)
    : Math.max(padding, Math.min(input.viewportHeight - padding - maxHeight, input.bottom + 4));

  return { top, left, width, maxHeight, placement };
}
