export interface NavigationBlockerCandidate {
  closest(selectors: string): unknown;
}

export function hasVisibleNavigationBlocker<T extends NavigationBlockerCandidate>(
  candidates: Iterable<T>,
  isVisible: (candidate: T) => boolean
): boolean {
  for (const candidate of candidates) {
    if (candidate.closest('[inert], [aria-hidden="true"]')) continue;
    if (isVisible(candidate)) return true;
  }
  return false;
}
