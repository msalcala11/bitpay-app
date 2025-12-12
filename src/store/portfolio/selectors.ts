import {RootState} from '../index';
import {BalancePoint, SeriesRefreshState, CryptoCheckpoint, PortfolioLoadState, BreakevenResult} from './portfolio.types';

export const selectPortfolioState = (state: RootState) => state.PORTFOLIO;

export const selectPortfolioSeriesByKey = (
  state: RootState,
  scopeKey: string,
): BalancePoint[] | undefined => state.PORTFOLIO.series[scopeKey];

export const selectCryptoTimelineByKey = (
  state: RootState,
  scopeKey: string,
): CryptoCheckpoint[] | undefined => state.PORTFOLIO.cryptoTimelines[scopeKey];

export const selectPortfolioStatusByKey = (
  state: RootState,
  scopeKey: string,
): PortfolioLoadState | undefined => state.PORTFOLIO.status[scopeKey];

export const selectSeriesRefreshStateByKey = (
  state: RootState,
  scopeKey: string,
): SeriesRefreshState | undefined => state.PORTFOLIO.seriesRefreshState[scopeKey];

export const selectBreakevenByKey = (
  state: RootState,
  scopeKey: string,
): BreakevenResult | undefined => state.PORTFOLIO.breakeven[scopeKey];

export const selectPortfolioQuoteCurrency = (state: RootState) =>
  state.APP.defaultAltCurrency.isoCode;
