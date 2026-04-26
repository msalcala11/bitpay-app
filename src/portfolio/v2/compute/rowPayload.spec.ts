import type {Series} from '../model';
import {
  buildRowFingerprint,
  buildRowPayloadFromSeries,
  buildWalletPointFromMark,
} from './rowPayload';

function expectValidPoint(
  result: ReturnType<typeof buildWalletPointFromMark>,
) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid point, received ${result.reason}`);
  }
  return result.point;
}

function expectValidRow(
  result: ReturnType<typeof buildRowPayloadFromSeries>,
) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid row, received ${result.reason}`);
  }
  return result.row;
}

describe('portfolio v2 row payload compute adapter', () => {
  it('builds strict wallet points and row endpoint payloads', () => {
    const first = expectValidPoint(
      buildWalletPointFromMark({
        ts: 1,
        units: 2,
        markRate: 100,
        remainingCostBasisFiat: 200,
      }),
    );
    const last = expectValidPoint(
      buildWalletPointFromMark({
        ts: 2,
        units: 2,
        markRate: 125,
        remainingCostBasisFiat: 200,
        firstRemainingUnrealizedPnlFiat: first.remainingUnrealizedPnlFiat,
      }),
    );
    const series: Pick<Series, 'interval' | 'points'> = {
      interval: '1D',
      points: [first, last],
    };

    expect(first).toEqual({
      ts: 1,
      fiatBalance: 200,
      remainingUnrealizedPnlFiat: 0,
      pnlChange: 0,
      pnlPercent: 0,
    });
    expect(last).toEqual({
      ts: 2,
      fiatBalance: 250,
      remainingUnrealizedPnlFiat: 50,
      pnlChange: 50,
      pnlPercent: 25,
    });

    const row = expectValidRow(
      buildRowPayloadFromSeries({
        assetGroupId: 'btc',
        series,
        rateStart: 100,
        rateEnd: 125,
      }),
    );

    expect(row).toEqual({
      assetGroupId: 'btc',
      rowFingerprint: buildRowFingerprint({
        assetGroupId: 'btc',
        interval: '1D',
        fiatStart: 200,
        fiatEnd: 250,
        pnlChange: 50,
        pnlPercent: 25,
        rateStart: 100,
        rateEnd: 125,
        ratePercent: 25,
      }),
      fiatStart: 200,
      fiatEnd: 250,
      pnlChange: 50,
      pnlPercent: 25,
      rateStart: 100,
      rateEnd: 125,
      ratePercent: 25,
    });
    expect(row.pnlPercent).toBe(row.ratePercent);
  });

  it('quarantines invalid wallet math instead of clamping it', () => {
    expect(
      buildWalletPointFromMark({
        ts: 1,
        units: 1,
        markRate: 100,
        remainingCostBasisFiat: -1,
      }),
    ).toEqual({
      kind: 'invalidHistory',
      reason: 'negativeRemainingCostBasis',
    });
    expect(
      buildWalletPointFromMark({
        ts: 1,
        units: -1,
        markRate: 100,
        remainingCostBasisFiat: 0,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'negativeUnits'});
    expect(
      buildWalletPointFromMark({
        ts: 1,
        units: 1,
        markRate: 0,
        remainingCostBasisFiat: 100,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'nonPositiveRate'});
    expect(
      buildWalletPointFromMark({
        ts: 1,
        units: 1,
        markRate: 100,
        remainingCostBasisFiat: Number.NaN,
      }),
    ).toEqual({
      kind: 'invalidHistory',
      reason: 'nonFiniteRemainingCostBasis',
    });
  });

  it('quarantines malformed row endpoints and non-positive row rates', () => {
    const validPoint = expectValidPoint(
      buildWalletPointFromMark({
        ts: 1,
        units: 1,
        markRate: 100,
        remainingCostBasisFiat: 80,
      }),
    );

    expect(
      buildRowPayloadFromSeries({
        assetGroupId: '',
        series: {interval: 'ALL', points: [validPoint]},
        rateStart: 100,
        rateEnd: 125,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'missingAssetGroupId'});
    expect(
      buildRowPayloadFromSeries({
        assetGroupId: 'eth',
        series: {interval: 'ALL', points: []},
        rateStart: 100,
        rateEnd: 125,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'emptySeries'});
    expect(
      buildRowPayloadFromSeries({
        assetGroupId: 'eth',
        series: {
          interval: 'ALL',
          points: [
            validPoint,
            {...validPoint, pnlPercent: Number.POSITIVE_INFINITY},
          ],
        },
        rateStart: 100,
        rateEnd: 125,
      }),
    ).toEqual({
      kind: 'invalidHistory',
      reason: 'invalidSeriesEndpoint',
    });
    expect(
      buildRowPayloadFromSeries({
        assetGroupId: 'eth',
        series: {
          interval: 'ALL',
          points: [validPoint, {...validPoint, ts: 0}],
        },
        rateStart: 100,
        rateEnd: 125,
      }),
    ).toEqual({
      kind: 'invalidHistory',
      reason: 'malformedSeriesTimeline',
    });
    expect(
      buildRowPayloadFromSeries({
        assetGroupId: 'eth',
        series: {
          interval: 'ALL',
          points: [validPoint, {...validPoint}],
        },
        rateStart: 100,
        rateEnd: 125,
      }),
    ).toEqual({
      kind: 'invalidHistory',
      reason: 'malformedSeriesTimeline',
    });
    expect(
      buildRowPayloadFromSeries({
        assetGroupId: 'eth',
        series: {interval: 'ALL', points: [validPoint]},
        rateStart: 0,
        rateEnd: 125,
      }),
    ).toEqual({kind: 'invalidHistory', reason: 'nonPositiveRate'});
  });

  it('changes the row fingerprint when any endpoint field changes', () => {
    const base = buildRowFingerprint({
      assetGroupId: 'usdc',
      interval: 'ALL',
      fiatStart: 100,
      fiatEnd: 110,
      pnlChange: 10,
      pnlPercent: 9.090909090909092,
      rateStart: 1,
      rateEnd: 1.1,
      ratePercent: 10,
    });
    const changed = buildRowFingerprint({
      assetGroupId: 'usdc',
      interval: 'ALL',
      fiatStart: 100,
      fiatEnd: 110,
      pnlChange: 10,
      pnlPercent: 9.090909090909092,
      rateStart: 1,
      rateEnd: 1.2,
      ratePercent: 20,
    });

    expect(base).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(changed).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    expect(changed).not.toBe(base);
  });
});
