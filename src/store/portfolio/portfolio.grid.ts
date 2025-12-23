import {PortfolioInterval} from './portfolio.types';

export const PORTFOLIO_GRID_POINTS = 45;

export const PORTFOLIO_ALL_DURATION_SECONDS = 10 * 365 * 86400;

export interface PortfolioIntervalGrid {
  stepSeconds: number;
  endTime: number;
  times: number[];
}

export const getPortfolioIntervalDurationSeconds = (
  interval: PortfolioInterval,
): number => {
  'worklet';
  switch (interval) {
    case 'day':
      return 1 * 86400;
    case 'week':
      return 7 * 86400;
    case 'month':
      return 30 * 86400;
    case '3months':
      return 90 * 86400;
    case 'year':
      return 365 * 86400;
    case '5years':
      return 5 * 365 * 86400;
    case 'all':
      return PORTFOLIO_ALL_DURATION_SECONDS;
    default: {
      const _exhaustiveCheck: never = interval;
      return _exhaustiveCheck;
    }
  }
};

export const getPortfolioIntervalGrid = (
  interval: PortfolioInterval,
  nowMs: number = Date.now(),
  firstReceiveTimeSec?: number,
): PortfolioIntervalGrid => {
  'worklet';
  const nowSec = Math.floor(nowMs / 1000);
  const endTime = Math.floor(nowSec / 3600) * 3600;

  if (interval === 'all') {
    const startBase = firstReceiveTimeSec ?? nowSec;
    const startTime = Math.floor(startBase / 3600) * 3600;
    const durationSeconds = Math.max(1, endTime - startTime);
    const stepSeconds = Math.max(
      1,
      Math.round(durationSeconds / (PORTFOLIO_GRID_POINTS - 1)),
    );
    const times = Array.from({length: PORTFOLIO_GRID_POINTS}, (_, i) =>
      startTime + i * stepSeconds,
    );
    return {
      stepSeconds,
      endTime,
      times,
    };
  }

  const durationSeconds = getPortfolioIntervalDurationSeconds(interval);
  const stepSeconds = Math.max(
    1,
    Math.round(durationSeconds / (PORTFOLIO_GRID_POINTS - 1)),
  );

  const times = Array.from({length: PORTFOLIO_GRID_POINTS}, (_, i) =>
    endTime - (PORTFOLIO_GRID_POINTS - 1 - i) * stepSeconds,
  );

  return {
    stepSeconds,
    endTime,
    times,
  };
};
