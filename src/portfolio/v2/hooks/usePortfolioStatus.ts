import {useMemo} from 'react';

import type {PortfolioStatus, ScopeReadiness} from '../model';
import {usePortfolioSlice} from './usePortfolioSlice';

export type PortfolioStatusSnapshot = Readonly<{
  status: PortfolioStatus;
  readiness?: ScopeReadiness;
}>;

export function usePortfolioStatus(scopeKey = 'home'): PortfolioStatusSnapshot {
  const status = usePortfolioSlice(state => state.status);
  const readiness = usePortfolioSlice(
    state => state.readinessByScopeKey[scopeKey],
  );

  return useMemo(() => ({status, readiness}), [readiness, status]);
}
