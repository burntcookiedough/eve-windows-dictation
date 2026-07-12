export interface LatestRequestGuard {
  begin(): number;
  isCurrent(requestId: number): boolean;
  invalidate(): void;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latestRequestId = 0;

  return {
    begin: () => ++latestRequestId,
    isCurrent: (requestId) => requestId === latestRequestId,
    invalidate: () => {
      latestRequestId += 1;
    },
  };
}
