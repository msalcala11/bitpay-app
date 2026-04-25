import type {ScopeReadiness} from '../model';
import {usePortfolioSlice} from './usePortfolioSlice';

export function usePortfolioStatus(
  scopeKey = 'home',
): ScopeReadiness | undefined {
  return usePortfolioSlice(state => state.readinessByScopeKey[scopeKey]);
}
