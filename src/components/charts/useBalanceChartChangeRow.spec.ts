import type {GraphPoint} from 'react-native-graph';
import {resolveBalanceChartChangeRowData} from './useBalanceChartChangeRow';

describe('resolveBalanceChartChangeRowData', () => {
  const pointTimestamp = 1234567890;
  const displayedAnalysisPoint = {
    timestamp: pointTimestamp,
    totalUnrealizedPnlFiat: 42,
    totalPnlPercent: 7.5,
  } as any;

  it('uses the timeframe label when no chart point is selected', () => {
    const result = resolveBalanceChartChangeRowData({
      displayedAnalysisPoint,
      pointMetadataByTimestampMs: new Map([
        [
          pointTimestamp,
          {
            selectedPointLabel: 'Mar 10, 2026',
            deltaFiatFormatted: '$42.00',
          },
        ],
      ]),
      quoteCurrency: 'USD',
      rangeLabel: 'Past 5 Years',
    });

    expect(result).toEqual({
      percent: 7.5,
      deltaFiatFormatted: '$42.00',
      rangeLabel: 'Past 5 Years',
    });
  });

  it('uses the selected point label while scrubbing', () => {
    const selectedPoint = {
      date: new Date(pointTimestamp),
      value: 100,
    } as GraphPoint;

    const result = resolveBalanceChartChangeRowData({
      displayedAnalysisPoint,
      pointMetadataByTimestampMs: new Map([
        [
          pointTimestamp,
          {
            selectedPointLabel: 'Mar 10, 2026',
            deltaFiatFormatted: '$42.00',
          },
        ],
      ]),
      quoteCurrency: 'USD',
      rangeLabel: 'Past 5 Years',
      selectedPoint,
    });

    expect(result).toEqual({
      percent: 7.5,
      deltaFiatFormatted: '$42.00',
      rangeLabel: 'Mar 10, 2026',
    });
  });
});
