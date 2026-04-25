import type {RecomputeRequest} from './recompute';

const pendingRecomputes: RecomputeRequest[] = [];

export function scheduleRecompute(request: RecomputeRequest): void {
  pendingRecomputes.push(request);
}

export function getPendingRecomputesForTesting(): RecomputeRequest[] {
  return pendingRecomputes.slice();
}

export function clearPendingRecomputesForTesting(): void {
  pendingRecomputes.length = 0;
}
