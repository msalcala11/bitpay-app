import type {Point, PortfolioPublishedState, Series} from './model';

export type WorkletPortfolioSelector<T> = (state: PortfolioPublishedState) => T;

export function getSeriesIdlePoint(series: Series): Point | undefined {
  return series.points[series.points.length - 1];
}
