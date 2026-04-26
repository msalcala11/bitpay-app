import {useSyncExternalStore} from 'react';

import {
  sharedPortfolioState,
  subscribeToPortfolioPublishedState,
} from '../sharedState';
import type {PortfolioPublishedState} from '../model';

export function usePortfolioSlice<T>(
  selector: (state: PortfolioPublishedState) => T,
): T {
  return useSyncExternalStore(
    subscribeToPortfolioPublishedState,
    () => selector(sharedPortfolioState.value),
    () => selector(sharedPortfolioState.value),
  );
}
