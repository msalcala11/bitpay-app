import {buildAssetBalanceHistoryIdleSummary} from './assetBalanceHistorySummary';

jest.mock('../../../../utils/helper-methods', () => ({
  formatFiatAmount: jest.fn((amount: number, quoteCurrency: string) => {
    return `${quoteCurrency}:${amount}`;
  }),
}));

describe('buildAssetBalanceHistoryIdleSummary', () => {
  it('uses the last analysis point for both balance and pnl change row', () => {
    expect(
      buildAssetBalanceHistoryIdleSummary({
        analysis: {
          points: [
            {
              totalFiatBalance: 100,
              totalUnrealizedPnlFiat: 10,
              totalPnlPercent: 5,
            },
            {
              totalFiatBalance: 125,
              totalUnrealizedPnlFiat: 25,
              totalPnlPercent: 12.5,
            },
          ],
        } as any,
        quoteCurrency: 'USD',
        rangeLabel: '1D',
      }),
    ).toEqual({
      assetBalance: 125,
      changeRow: {
        percent: 12.5,
        deltaFiatFormatted: 'USD:25',
        rangeLabel: '1D',
      },
    });
  });

  it('returns no balance or change row when analysis has no points', () => {
    expect(
      buildAssetBalanceHistoryIdleSummary({
        analysis: {points: []} as any,
        quoteCurrency: 'USD',
        rangeLabel: '1D',
      }),
    ).toEqual({
      assetBalance: undefined,
      changeRow: undefined,
    });
  });
});
