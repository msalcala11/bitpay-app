import {
  resolvePortfolioIntervalWindow,
  resolveStoredRateInterval,
  resolveStoredRateIntervalForChartWindow,
} from './intervalWindow';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('portfolio v2 interval window helpers', () => {
  it('resolves display intervals to stored intervals at static boundaries', () => {
    expect(resolveStoredRateInterval('1D')).toBe('1D');
    expect(resolveStoredRateInterval('1W')).toBe('1W');
    expect(resolveStoredRateInterval('1M')).toBe('1M');
    expect(resolveStoredRateInterval('3M')).toBe('ALL');
    expect(resolveStoredRateInterval('1Y')).toBe('ALL');
    expect(resolveStoredRateInterval('5Y')).toBe('ALL');
    expect(resolveStoredRateInterval('ALL')).toBe('ALL');
  });

  it('uses adaptive stored intervals for short ALL chart windows', () => {
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: 'ALL',
        windowStartTs: 100,
        windowEndTs: 100 + DAY_MS / 2,
      }),
    ).toBe('1D');
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: 'ALL',
        windowStartTs: 100,
        windowEndTs: 100 + 3 * DAY_MS,
      }),
    ).toBe('1W');
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: 'ALL',
        windowStartTs: 100,
        windowEndTs: 100 + 20 * DAY_MS,
      }),
    ).toBe('1M');
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: 'ALL',
        windowStartTs: 100,
        windowEndTs: 100 + 40 * DAY_MS,
      }),
    ).toBe('ALL');
  });

  it('pins start/end/anchor identity for screens mounted at different times', () => {
    const sharedAnchor = Date.parse('2024-01-02T12:00:00Z');
    const home = resolvePortfolioIntervalWindow({
      interval: '1D',
      windowAnchorTs: sharedAnchor,
    });
    const assetDetail = resolvePortfolioIntervalWindow({
      interval: '1D',
      windowAnchorTs: sharedAnchor,
    });
    const exchangeRate = resolvePortfolioIntervalWindow({
      interval: '1D',
      windowAnchorTs: sharedAnchor,
    });

    expect(home).toEqual(assetDetail);
    expect(assetDetail).toEqual(exchangeRate);
    expect(home).toMatchObject({
      windowStartTs: sharedAnchor - DAY_MS,
      windowEndTs: sharedAnchor,
      windowAnchorTs: sharedAnchor,
      sampledFromStoredInterval: '1D',
    });
  });

  it('returns undefined for degenerate or unresolved windows', () => {
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: '1D',
        windowStartTs: 2,
        windowEndTs: 1,
      }),
    ).toBeUndefined();
    expect(
      resolvePortfolioIntervalWindow({
        interval: 'ALL',
        windowAnchorTs: 100,
      }),
    ).toBeUndefined();
    expect(
      resolvePortfolioIntervalWindow({
        interval: 'ALL',
        firstPortfolioEventTs: 100,
        windowAnchorTs: 100,
      }),
    ).toBeUndefined();
  });

  it('rejects fractional external window identity timestamps', () => {
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: '1D',
        windowStartTs: 100.5,
        windowEndTs: 100 + DAY_MS,
      }),
    ).toBeUndefined();
    expect(
      resolveStoredRateIntervalForChartWindow({
        interval: 'ALL',
        windowStartTs: 100,
        windowEndTs: 100 + DAY_MS + 0.5,
      }),
    ).toBeUndefined();
    expect(
      resolvePortfolioIntervalWindow({
        interval: '1D',
        windowAnchorTs: 100.5,
      }),
    ).toBeUndefined();
    expect(
      resolvePortfolioIntervalWindow({
        interval: 'ALL',
        firstPortfolioEventTs: 1.5,
        windowAnchorTs: 100,
      }),
    ).toBeUndefined();
  });
});
