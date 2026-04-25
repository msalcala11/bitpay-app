import type {Interval, Series} from '../model';
import {usePortfolioSlice} from './usePortfolioSlice';

export function usePortfolioChart(interval: Interval): Series | undefined {
  return usePortfolioSlice(state => state.total[interval]);
}
