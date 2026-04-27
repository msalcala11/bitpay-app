import type {Interval} from '../model';
import {usePortfolioChart} from './usePortfolioChart';

export type PortfolioChartAccessibility = Readonly<{
  interval: Interval;
  pointCount: number;
  windowStartTs?: number;
  windowEndTs?: number;
  windowAnchorTs?: number;
}>;

export function usePortfolioChartAccessibility(
  interval: Interval,
): PortfolioChartAccessibility {
  const series = usePortfolioChart(interval);

  return {
    interval,
    pointCount: series?.points.length ?? 0,
    ...(series
      ? {
          windowStartTs: series.windowStartTs,
          windowEndTs: series.windowEndTs,
          windowAnchorTs: series.windowAnchorTs,
        }
      : {}),
  };
}
