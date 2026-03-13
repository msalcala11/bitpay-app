import type {FiatRateInterval} from '../../store/rate/rate.models';
import type {CachedTimeframeStatus} from '../../utils/portfolio/chartCache';
import type {ComputedSeries} from './balanceHistoryChart.types';

export type BalanceChartSeriesByTimeframe = Partial<
  Record<FiatRateInterval, ComputedSeries>
>;

export type BalanceChartRevisionByTimeframe = Partial<
  Record<FiatRateInterval, string>
>;

export type BalanceChartBooleanByTimeframe = Partial<
  Record<FiatRateInterval, boolean>
>;

export type BalanceChartStatusByTimeframe = Partial<
  Record<FiatRateInterval, CachedTimeframeStatus>
>;

export type BalanceChartDisplayState =
  | {
      revision: string;
      series: ComputedSeries;
      timeframe: FiatRateInterval;
    }
  | undefined;
