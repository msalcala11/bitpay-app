import {useSyncExternalStore} from 'react';

import {sharedPortfolioState} from '../sharedState';
import type {PortfolioPublishedState} from '../model';

const subscribe = () => () => undefined;

export function usePortfolioSlice<T>(
  selector: (state: PortfolioPublishedState) => T,
): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(sharedPortfolioState.value),
    () => selector(sharedPortfolioState.value),
  );
}
