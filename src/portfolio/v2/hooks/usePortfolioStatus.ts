import type {PortfolioStatus, ScopeReadiness} from '../model';
import {usePortfolioSlice} from './usePortfolioSlice';

export type PortfolioStatusSnapshot = Readonly<{
  status: PortfolioStatus;
  readiness?: ScopeReadiness;
}>;

export function usePortfolioStatus(scopeKey = 'home'): PortfolioStatusSnapshot {
  return usePortfolioSlice(state => ({
    status: state.status,
    readiness: state.readinessByScopeKey[scopeKey],
  }));
}
