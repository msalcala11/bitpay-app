import {
  buildPortfolioComputedState,
  stableWalletIdsKey,
} from './portfolioState';
import {
  buildFormulaComputedInputs,
  buildQuoteBridgedFormulaComputedInputs,
  type BuildFormulaComputedInputsResult,
  type FormulaWalletIntervalInput,
} from './recomputeFormula';
import {
  IN_WINDOW_BUY_FIXTURE,
  NO_TRANSACTION_PARITY_FIXTURE,
  ORACLE_1D_WINDOW,
  ORACLE_TS,
} from '../__tests__/fixtures/productOracles';

function expectValidFormula(result: BuildFormulaComputedInputsResult) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid formula inputs, received ${result.reason}`);
  }
  return result;
}

function expectValidState(
  result: ReturnType<typeof buildPortfolioComputedState>,
) {
  expect(result.kind).toBe('valid');
  if (result.kind !== 'valid') {
    throw new Error(`Expected valid state, received ${result.reason}`);
  }
  return result.state;
}

function oneDayInterval(
  overrides: Partial<FormulaWalletIntervalInput> = {},
): FormulaWalletIntervalInput {
  return {
    interval: '1D',
    seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:1|rate:1',
    windowStartTs: ORACLE_1D_WINDOW.windowStartTs,
    windowEndTs: ORACLE_1D_WINDOW.windowEndTs,
    sampledFromStoredInterval: '1D',
    finalPointSource: 'historicalRate',
    baselineUnits: NO_TRANSACTION_PARITY_FIXTURE.baselineUnits,
    ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
    maxPoints: 2,
    ...overrides,
  };
}

function buildSingleEthFormula(
  intervalOverrides: Partial<FormulaWalletIntervalInput> = {},
) {
  return buildFormulaComputedInputs({
    quoteCurrency: 'USD',
    wallets: [
      {
        walletId: 'eth-wallet',
        assetGroupId: 'eth',
        assetIdentityKey: 'eth',
        rateSourceKey: 'eth',
        displayUnitsAtomic: '2000000000000000000',
        displayUnitDecimals: 18,
        liveRate: 125,
        lastWrittenAt: 10,
        lastAccessedAt: 20,
        intervals: [oneDayInterval(intervalOverrides)],
      },
    ],
    assetGroups: [
      {
        assetGroupId: 'eth',
        displaySymbol: 'ETH',
        orderIndex: 1,
      },
    ],
  });
}

function buildCollapsedUsdcFormula(args?: {middleRateB?: number}) {
  const middleRateB = args?.middleRateB ?? 1.1;

  return buildFormulaComputedInputs({
    quoteCurrency: 'USD',
    wallets: [
      {
        walletId: 'eth-usdc',
        assetGroupId: 'usdc',
        assetIdentityKey: 'usdc|eth',
        rateSourceKey: 'usdc|eth',
        displayUnitsAtomic: '1000000',
        displayUnitDecimals: 6,
        liveRate: 1.2,
        lastWrittenAt: 10,
        lastAccessedAt: 20,
        intervals: [
          oneDayInterval({
            seriesIdentityKey: 'wallet:eth-usdc|snap:1|rate:1',
            baselineUnits: 100,
            ratePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.middle, rate: 1.05},
              {ts: ORACLE_TS.end, rate: 1.2},
            ],
            maxPoints: 3,
          }),
        ],
      },
      {
        walletId: 'pol-usdc',
        assetGroupId: 'usdc',
        assetIdentityKey: 'usdc|pol',
        rateSourceKey: 'usdc|pol',
        displayUnitsAtomic: '1000000',
        displayUnitDecimals: 6,
        liveRate: 1.2,
        lastWrittenAt: 11,
        lastAccessedAt: 21,
        intervals: [
          oneDayInterval({
            seriesIdentityKey: `wallet:pol-usdc|snap:1|rate:${middleRateB}`,
            baselineUnits: 100,
            ratePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.middle, rate: middleRateB},
              {ts: ORACLE_TS.end, rate: 1.2},
            ],
            maxPoints: 3,
          }),
        ],
      },
    ],
    assetGroups: [
      {
        assetGroupId: 'usdc',
        displaySymbol: 'USDC',
        orderIndex: 1,
        symbolCollisionSuspected: true,
      },
    ],
  });
}

const variableBridgeRates = {
  targetBtcRatePoints: [
    {ts: ORACLE_TS.start, rate: 0.9},
    {ts: ORACLE_TS.middle, rate: 1},
    {ts: ORACLE_TS.end, rate: 0.95},
  ],
  canonicalBtcRatePoints: [
    {ts: ORACLE_TS.start, rate: 1},
    {ts: ORACLE_TS.middle, rate: 1},
    {ts: ORACLE_TS.end, rate: 1},
  ],
  targetBtcLiveRate: 0.95,
  canonicalBtcLiveRate: 1,
};

describe('portfolio v2 formula recompute input builder', () => {
  it('wires no-transaction wallet formula output into state rows and detail equality', () => {
    const formula = expectValidFormula(buildSingleEthFormula());
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    const wallet = state.byWallet['eth-wallet'];
    const eth = state.byAssetGroup.eth;
    const walletPoints = wallet.series['1D']?.points ?? [];
    expect(walletPoints[walletPoints.length - 1]?.pnlPercent).toBe(25);
    expect(wallet.rowToday).toMatchObject({
      fiatStart: 200,
      fiatEnd: 250,
      pnlChange: 50,
      pnlPercent: 25,
      ratePercent: 25,
    });
    expect(eth.rowToday).toEqual(state.rowShells[0].rowToday);
    expect(eth.rowToday).toMatchObject(wallet.rowToday!);
    expect(state.status).toMatchObject({
      invalidHistoryWalletIds: [],
      missingRateSourceKeys: [],
    });
  });

  it('preserves row/detail equality for a key-scoped wallet set', () => {
    const formula = expectValidFormula(buildSingleEthFormula());
    const scopedWalletIds = ['eth-wallet'];
    const scopedWalletIdsKey = stableWalletIdsKey(scopedWalletIds);
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
        scopedSlices: [
          {
            walletIds: scopedWalletIds,
            walletIdsKey: scopedWalletIdsKey,
            assetGroups: formula.assetGroups,
            lastAccessedAt: 100,
          },
        ],
      }),
    );

    const wallet = state.byWallet['eth-wallet'];
    const scoped = state.scopedByWalletSet[scopedWalletIdsKey];
    const scopedEth = scoped?.byAssetGroup.eth;
    const scopedRowShell = scoped?.rowShells[0];

    expect(scoped).toBeDefined();
    expect(scoped?.walletIds).toEqual(['eth-wallet']);
    expect(scopedRowShell?.assetGroupId).toBe('eth');
    expect(scopedEth?.rowToday).toEqual(scopedRowShell?.rowToday);
    expect(scopedEth?.rowToday).toEqual(wallet.rowToday);
    expect(scopedEth?.rowToday).toMatchObject({
      fiatStart: 200,
      fiatEnd: 250,
      pnlChange: 50,
      pnlPercent: 25,
      ratePercent: 25,
    });
  });

  it('applies in-window transactions before assembly even when event timestamps are not emitted', () => {
    const formula = expectValidFormula(
      buildSingleEthFormula({
        baselineUnits: IN_WINDOW_BUY_FIXTURE.baselineUnits,
        balanceEvents: IN_WINDOW_BUY_FIXTURE.balanceEvents,
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    const points = state.byWallet['eth-wallet'].series['1D']?.points ?? [];
    const last = points[points.length - 1];
    expect(last?.fiatBalance).toBe(260);
    expect(last?.pnlChange).toBe(50);
    expect(last?.pnlPercent).toBeCloseTo((50 / 210) * 100, 10);
  });

  it('quarantines invalid wallet math while keeping shell/status context', () => {
    const formula = expectValidFormula(
      buildSingleEthFormula({
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: -2, order: 1}],
        ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        invalidHistoryWalletIds: formula.invalidHistoryWalletIds,
      }),
    );

    expect(formula.invalidHistoryWalletIds).toEqual(['eth-wallet']);
    expect(state.byWallet['eth-wallet'].series).toEqual({});
    expect(state.status.invalidHistoryWalletIds).toEqual(['eth-wallet']);
    expect(state.rowShells[0]).toMatchObject({
      assetGroupId: 'eth',
      invalidHistoryBlocked: true,
      readyToday: false,
    });
  });

  it('treats invalid-history as wallet-wide across intervals', () => {
    const formula = expectValidFormula(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 125,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval(),
              oneDayInterval({
                interval: 'ALL',
                sampledFromStoredInterval: 'ALL',
                seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:all',
                baselineUnits: 1,
                balanceEvents: [
                  {ts: ORACLE_TS.middle, unitsDelta: -2, order: 1},
                ],
                ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    );

    expect(formula.invalidHistoryWalletIds).toEqual(['eth-wallet']);
    expect(formula.wallets[0].series).toEqual({});
    expect(formula.wallets[0].rowToday).toBeUndefined();
  });

  it('propagates missing rate source status without publishing partial rows', () => {
    const formula = expectValidFormula(
      buildSingleEthFormula({
        baselineUnits: 1,
        balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: 1, order: 1}],
        ratePoints: [
          {ts: ORACLE_TS.start, rate: 100},
          {ts: ORACLE_TS.middle - 1, rate: 110},
        ],
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        missingRateSourceKeys: formula.missingRateSourceKeys,
      }),
    );

    expect(formula.missingRateSourceKeys).toEqual(['eth']);
    expect(state.byWallet['eth-wallet'].rowToday).toBeUndefined();
    expect(state.byAssetGroup.eth.rowToday).toBeUndefined();
    expect(state.status.missingRateSourceKeys).toEqual(['eth']);
  });

  it('changes wallet and asset-group fingerprints when formula identity changes', () => {
    const first = expectValidFormula(
      buildSingleEthFormula({
        seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:1|rate:1',
      }),
    );
    const second = expectValidFormula(
      buildSingleEthFormula({
        seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:2|rate:1',
      }),
    );

    expect(first.wallets[0].series['1D']?.points).toEqual(
      second.wallets[0].series['1D']?.points,
    );
    expect(first.wallets[0].series['1D']?.fingerprint).not.toBe(
      second.wallets[0].series['1D']?.fingerprint,
    );

    const firstState = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: first.wallets,
        assetGroups: first.assetGroups,
      }),
    );
    const secondState = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: second.wallets,
        assetGroups: second.assetGroups,
      }),
    );

    expect(firstState.byWallet['eth-wallet'].fingerprint).not.toBe(
      secondState.byWallet['eth-wallet'].fingerprint,
    );
    expect(firstState.byAssetGroup.eth.fingerprint).not.toBe(
      secondState.byAssetGroup.eth.fingerprint,
    );
  });

  it('builds collapsed weighted state from full-grid market constituents', () => {
    const first = expectValidFormula(buildCollapsedUsdcFormula());
    const second = expectValidFormula(
      buildCollapsedUsdcFormula({middleRateB: 1.15}),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: first.wallets,
        assetGroups: first.assetGroups,
      }),
    );
    const changedMiddleState = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: second.wallets,
        assetGroups: second.assetGroups,
      }),
    );

    const weighted = state.byAssetGroup.usdc.weightedGroupRateSeries?.['1D'];
    const changedWeighted =
      changedMiddleState.byAssetGroup.usdc.weightedGroupRateSeries?.['1D'];
    expect(weighted?.availability).toBe('valid');
    expect(weighted?.points).toHaveLength(3);
    expect(weighted?.points.map(point => point.ts)).toEqual([
      ORACLE_TS.start,
      ORACLE_TS.middle,
      ORACLE_TS.end,
    ]);
    expect(changedWeighted?.points[0]).toEqual(weighted?.points[0]);
    expect(changedWeighted?.points[2]).toEqual(weighted?.points[2]);
    expect(changedWeighted?.fingerprint).not.toBe(weighted?.fingerprint);
    expect(state.byAssetGroup.usdc.rowToday).toEqual(
      state.rowShells[0].rowToday,
    );
    expect(state.rowShells[0].groupHealth.symbolCollisionSuspected).toBe(true);
  });

  it('publishes collapsed weighted missing-rate intervals when group pnl series is suppressed', () => {
    const formula = expectValidFormula(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|eth',
            rateSourceKey: 'usdc|eth',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:eth-usdc|snap:1|rate:1',
                baselineUnits: 100,
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 2,
              }),
            ],
          },
          {
            walletId: 'pol-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|pol',
            rateSourceKey: 'usdc|pol',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 11,
            lastAccessedAt: 21,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:pol-usdc|snap:missing|rate:1',
                baselineUnits: 100,
                ratePoints: [{ts: ORACLE_TS.start, rate: 1}],
                maxPoints: 2,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'usdc',
            displaySymbol: 'USDC',
            orderIndex: 1,
          },
        ],
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        missingRateSourceKeys: formula.missingRateSourceKeys,
      }),
    );

    expect(formula.assetGroups[0].series['1D']).toBeUndefined();
    expect(formula.missingRateSourceKeys).toEqual(['usdc|pol']);
    expect(
      state.byAssetGroup.usdc.weightedGroupRateSeries?.['1D'],
    ).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'missingConstituentRate',
      points: [],
    });
    expect(state.byAssetGroup.usdc.rowToday).toBeUndefined();
    expect(state.rowShells[0]).toMatchObject({
      assetGroupId: 'usdc',
      readyToday: false,
    });
  });

  it('excludes invalid-history wallets from collapsed weighted constituent rows', () => {
    const formula = expectValidFormula(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|eth',
            rateSourceKey: 'usdc|eth',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:eth-usdc|snap:1|rate:1',
                baselineUnits: 100,
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.middle, rate: 1.05},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
          {
            walletId: 'pol-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|pol',
            rateSourceKey: 'usdc|pol',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 11,
            lastAccessedAt: 21,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:pol-usdc|snap:bad|rate:1',
                baselineUnits: 1,
                balanceEvents: [
                  {ts: ORACLE_TS.middle, unitsDelta: -2, order: 1},
                ],
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.middle, rate: 1.1},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'usdc',
            displaySymbol: 'USDC',
            orderIndex: 1,
          },
        ],
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        invalidHistoryWalletIds: formula.invalidHistoryWalletIds,
      }),
    );

    expect(formula.invalidHistoryWalletIds).toEqual(['pol-usdc']);
    expect(state.byAssetGroup.usdc.weightedGroupRateSeries).toBeUndefined();
    expect(state.byAssetGroup.usdc.rowToday).toMatchObject({
      fiatStart: 100,
      fiatEnd: 120,
      pnlChange: 20,
      pnlPercent: 20,
    });
    expect(state.byAssetGroup.usdc.rowToday?.ratePercent).toBeCloseTo(20, 10);
    expect(state.rowShells[0]).toMatchObject({
      assetGroupId: 'usdc',
      invalidHistoryBlocked: true,
      readyToday: true,
    });
  });

  it('builds weighted rows from remaining valid members when another collapsed member is invalid-history', () => {
    const formula = expectValidFormula(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|eth',
            rateSourceKey: 'usdc|eth',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:eth-usdc|snap:1|rate:1',
                baselineUnits: 100,
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.middle, rate: 1.05},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
          {
            walletId: 'pol-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|pol',
            rateSourceKey: 'usdc|pol',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 11,
            lastAccessedAt: 21,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:pol-usdc|snap:1|rate:1',
                baselineUnits: 100,
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.middle, rate: 1.1},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
          {
            walletId: 'sol-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|sol',
            rateSourceKey: 'usdc|sol',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 12,
            lastAccessedAt: 22,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:sol-usdc|snap:bad|rate:1',
                baselineUnits: 1,
                balanceEvents: [
                  {ts: ORACLE_TS.middle, unitsDelta: -2, order: 1},
                ],
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'usdc',
            displaySymbol: 'USDC',
            orderIndex: 1,
          },
        ],
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'USD',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        invalidHistoryWalletIds: formula.invalidHistoryWalletIds,
      }),
    );

    const weighted = state.byAssetGroup.usdc.weightedGroupRateSeries?.['1D'];
    expect(formula.invalidHistoryWalletIds).toEqual(['sol-usdc']);
    expect(weighted?.availability).toBe('valid');
    if (weighted?.availability !== 'valid') {
      throw new Error('Expected weighted series from valid USDC members');
    }
    expect(weighted.baselineUnitsByRateSourceKey).toEqual({
      'usdc|eth': 100,
      'usdc|pol': 100,
    });
    expect(weighted.baselineUnitsByRateSourceKey).not.toHaveProperty(
      'usdc|sol',
    );
    expect(state.rowShells[0]).toMatchObject({
      assetGroupId: 'usdc',
      invalidHistoryBlocked: true,
      readyToday: true,
    });
  });

  it('quote-bridges in-window transaction formula output to match from-scratch target recompute', () => {
    const canonicalWallet = {
      walletId: 'eth-wallet',
      assetGroupId: 'eth',
      assetIdentityKey: 'eth',
      rateSourceKey: 'eth',
      displayUnitsAtomic: '2000000000000000000',
      displayUnitDecimals: 18,
      liveRate: 117,
      lastWrittenAt: 10,
      lastAccessedAt: 20,
      intervals: [
        oneDayInterval({
          seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:1|rate:1',
          baselineUnits: IN_WINDOW_BUY_FIXTURE.baselineUnits,
          balanceEvents: IN_WINDOW_BUY_FIXTURE.balanceEvents,
          ratePoints: IN_WINDOW_BUY_FIXTURE.ratePoints,
        }),
      ],
    };
    const targetWallet = {
      ...canonicalWallet,
      liveRate: 105.3,
      intervals: canonicalWallet.intervals.map(interval => ({
        ...interval,
        seriesIdentityKey: 'wallet:eth|asset:eth|quote:EUR|snap:1|rate:1',
        ratePoints: interval.ratePoints.map(point => ({
          ts: point.ts,
          rate: point.rate * 0.9,
        })),
      })),
    };
    const assetGroups = [
      {
        assetGroupId: 'eth',
        displaySymbol: 'ETH',
        orderIndex: 1,
      },
    ];
    const bridged = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [canonicalWallet],
        assetGroups,
        bridgeRatePointsByStoredInterval: {
          '1D': {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.9},
              {ts: ORACLE_TS.middle, rate: 0.9},
              {ts: ORACLE_TS.end, rate: 0.9},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.middle, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.9,
            canonicalBtcLiveRate: 1,
          },
        },
      }),
    );
    const fromScratch = expectValidFormula(
      buildFormulaComputedInputs({
        quoteCurrency: 'EUR',
        wallets: [targetWallet],
        assetGroups,
      }),
    );

    expect(bridged.wallets[0].series['1D']?.points).toEqual(
      fromScratch.wallets[0].series['1D']?.points,
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'EUR',
        computedAtMs: 100,
        wallets: bridged.wallets,
        assetGroups: bridged.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    expect(state.byAssetGroup.eth.rowToday).toEqual(
      state.rowShells[0].rowToday,
    );
    expect(bridged.assetGroups[0].members[0].liveRate).toBeCloseTo(105.3, 10);
    expect(state.rowShells[0].currentFiatValue).toBeCloseTo(210.6, 10);
    expect(state.byAssetGroup.eth.rowToday?.rateStart).toBe(90);
    expect(state.byAssetGroup.eth.rowToday?.rateEnd).toBe(117);
  });

  it('quote-bridges collapsed weighted groups per timestamp', () => {
    const bridged = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|eth',
            rateSourceKey: 'usdc|eth',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:eth-usdc|snap:1|rate:1',
                baselineUnits: 100,
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.middle, rate: 1.05},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
          {
            walletId: 'pol-usdc',
            assetGroupId: 'usdc',
            assetIdentityKey: 'usdc|pol',
            rateSourceKey: 'usdc|pol',
            displayUnitsAtomic: '1000000',
            displayUnitDecimals: 6,
            liveRate: 1.2,
            lastWrittenAt: 11,
            lastAccessedAt: 21,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: 'wallet:pol-usdc|snap:1|rate:1.1',
                baselineUnits: 100,
                ratePoints: [
                  {ts: ORACLE_TS.start, rate: 1},
                  {ts: ORACLE_TS.middle, rate: 1.1},
                  {ts: ORACLE_TS.end, rate: 1.2},
                ],
                maxPoints: 3,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'usdc',
            displaySymbol: 'USDC',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {
          '1D': variableBridgeRates,
        },
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'EUR',
        computedAtMs: 100,
        wallets: bridged.wallets,
        assetGroups: bridged.assetGroups,
        populatedWalletIds: ['eth-usdc', 'pol-usdc'],
      }),
    );

    const weighted = state.byAssetGroup.usdc.weightedGroupRateSeries?.['1D'];
    expect(weighted?.availability).toBe('valid');
    if (weighted?.availability !== 'valid') {
      throw new Error('Expected valid weighted quote bridge series');
    }
    expect(weighted.points.map(point => point.weightedRate)).toEqual([
      0.9, 1.075, 1.14,
    ]);
    expect(weighted.points[2].weightedPercent).toBeCloseTo(
      ((1.14 - 0.9) / 0.9) * 100,
      10,
    );
    expect(state.byAssetGroup.usdc.rowToday).toEqual(
      state.rowShells[0].rowToday,
    );
    expect(state.rowShells[0].currentFiatValue).toBeCloseTo(2.28, 10);
    expect(state.byAssetGroup.usdc.rowToday?.rateStart).toBe(0.9);
    expect(state.byAssetGroup.usdc.rowToday?.rateEnd).toBe(1.14);
    expect(state.byAssetGroup.usdc.rowToday?.ratePercent).toBeCloseTo(
      ((1.14 - 0.9) / 0.9) * 100,
      10,
    );
  });

  it('uses sampled ALL bridge coverage for long display intervals', () => {
    const formula = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 125,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                interval: '3M',
                sampledFromStoredInterval: 'ALL',
                seriesIdentityKey:
                  'wallet:eth|asset:eth|quote:USD|snap:1|rate:all',
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {
          ALL: {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.8},
              {ts: ORACLE_TS.end, rate: 0.8},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.8,
            canonicalBtcLiveRate: 1,
          },
        },
      }),
    );

    expect(formula.missingRateSourceKeys).toEqual([]);
    expect(formula.wallets[0].series['3M']?.points).toEqual([
      {
        ts: ORACLE_TS.start,
        fiatBalance: 160,
        remainingUnrealizedPnlFiat: 0,
        pnlChange: 0,
        pnlPercent: 0,
      },
      {
        ts: ORACLE_TS.end,
        fiatBalance: 200,
        remainingUnrealizedPnlFiat: 40,
        pnlChange: 40,
        pnlPercent: 25,
      },
    ]);
    expect(formula.assetGroups[0].members[0].liveRate).toBe(100);
  });

  it('does not leak canonical live rates when live bridge coverage is unavailable', () => {
    const formula = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 125,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [oneDayInterval()],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {
          '1D': {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.9},
              {ts: ORACLE_TS.end, rate: 0.9},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
          },
        },
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'EUR',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    expect(state.byWallet['eth-wallet'].series['1D']).toBeDefined();
    expect(state.rowShells[0].currentFiatValue).toBeUndefined();
    expect(
      state.rowShells[0].groupHealth.nonzeroMissingLiveRateMemberWalletIds,
    ).toEqual(['eth-wallet']);
  });

  it('does not pick an interval-order-dependent live bridge rate', () => {
    const formula = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 125,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval(),
              oneDayInterval({
                interval: 'ALL',
                sampledFromStoredInterval: 'ALL',
                seriesIdentityKey:
                  'wallet:eth|asset:eth|quote:USD|snap:1|rate:all',
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {
          '1D': {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.9},
              {ts: ORACLE_TS.end, rate: 0.9},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.9,
            canonicalBtcLiveRate: 1,
          },
          ALL: {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.8},
              {ts: ORACLE_TS.end, rate: 0.8},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.8,
            canonicalBtcLiveRate: 1,
          },
        },
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'EUR',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    expect(state.byWallet['eth-wallet'].series['1D']).toBeDefined();
    expect(state.byWallet['eth-wallet'].series.ALL).toBeDefined();
    expect(state.rowShells[0].currentFiatValue).toBeUndefined();
    expect(
      state.rowShells[0].groupHealth.nonzeroMissingLiveRateMemberWalletIds,
    ).toEqual(['eth-wallet']);
  });

  it('does not let unrelated bridge buckets block wallet live-rate bridging', () => {
    const formula = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 125,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [oneDayInterval()],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {
          '1D': {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.9},
              {ts: ORACLE_TS.end, rate: 0.9},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.9,
            canonicalBtcLiveRate: 1,
          },
          ALL: {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.8},
              {ts: ORACLE_TS.end, rate: 0.8},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.8,
            canonicalBtcLiveRate: 1,
          },
        },
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'EUR',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    expect(state.byWallet['eth-wallet'].series['1D']).toBeDefined();
    expect(formula.assetGroups[0].members[0].liveRate).toBeCloseTo(112.5, 10);
    expect(state.rowShells[0].currentFiatValue).toBeCloseTo(225, 10);
  });

  it('uses a valid live bridge when another used interval omits live metadata', () => {
    const formula = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 125,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval(),
              oneDayInterval({
                interval: 'ALL',
                sampledFromStoredInterval: 'ALL',
                seriesIdentityKey:
                  'wallet:eth|asset:eth|quote:USD|snap:1|rate:all',
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {
          '1D': {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.9},
              {ts: ORACLE_TS.end, rate: 0.9},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
            targetBtcLiveRate: 0.9,
            canonicalBtcLiveRate: 1,
          },
          ALL: {
            targetBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 0.9},
              {ts: ORACLE_TS.end, rate: 0.9},
            ],
            canonicalBtcRatePoints: [
              {ts: ORACLE_TS.start, rate: 1},
              {ts: ORACLE_TS.end, rate: 1},
            ],
          },
        },
      }),
    );
    const state = expectValidState(
      buildPortfolioComputedState({
        workEpoch: 1,
        revision: 1,
        quoteCurrency: 'EUR',
        computedAtMs: 100,
        wallets: formula.wallets,
        assetGroups: formula.assetGroups,
        populatedWalletIds: ['eth-wallet'],
      }),
    );

    expect(state.byWallet['eth-wallet'].series['1D']).toBeDefined();
    expect(state.byWallet['eth-wallet'].series.ALL).toBeDefined();
    expect(formula.assetGroups[0].members[0].liveRate).toBeCloseTo(112.5, 10);
    expect(state.rowShells[0].currentFiatValue).toBeCloseTo(225, 10);
  });

  it('reports missing rate sources when quote bridge coverage is unavailable', () => {
    const formula = expectValidFormula(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            liveRate: 117,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [oneDayInterval()],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
        bridgeRatePointsByStoredInterval: {},
      }),
    );

    expect(formula.wallets[0].series).toEqual({});
    expect(formula.wallets[0].rowToday).toBeUndefined();
    expect(formula.missingRateSourceKeys).toEqual(['eth']);
  });

  it('rejects malformed quote bridge quote identities', () => {
    expect(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: ' EUR',
        wallets: [],
        assetGroups: [],
        bridgeRatePointsByStoredInterval: {},
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidQuoteCurrency'});
    expect(
      buildQuoteBridgedFormulaComputedInputs({
        targetQuoteCurrency: 'EUR',
        canonicalQuoteCurrency: '',
        wallets: [],
        assetGroups: [],
        bridgeRatePointsByStoredInterval: {},
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidQuoteCurrency'});
  });

  it('rejects malformed formula bridge inputs before state assembly', () => {
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: ' USD',
        wallets: [],
        assetGroups: [],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidQuoteCurrency'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 2,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'duplicateAssetGroupId'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [oneDayInterval(), oneDayInterval()],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'duplicateWalletInterval'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: ' eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [oneDayInterval()],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletIdentity'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '-1',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [oneDayInterval()],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidDisplayUnitsAtomic'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                interval: 'BAD' as any,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletInterval'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                sampledFromStoredInterval: '3M' as any,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletInterval'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                finalPointSource: 'bad' as any,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletInterval'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                seriesIdentityKey: ' bad',
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletIntervalIdentity'});
    expect(
      buildFormulaComputedInputs({
        quoteCurrency: 'USD',
        wallets: [
          {
            walletId: 'eth-wallet',
            assetGroupId: 'eth',
            assetIdentityKey: 'eth',
            rateSourceKey: 'eth',
            displayUnitsAtomic: '2000000000000000000',
            displayUnitDecimals: 18,
            lastWrittenAt: 10,
            lastAccessedAt: 20,
            intervals: [
              oneDayInterval({
                windowEndTs: ORACLE_TS.start,
              }),
            ],
          },
        ],
        assetGroups: [
          {
            assetGroupId: 'eth',
            displaySymbol: 'ETH',
            orderIndex: 1,
          },
        ],
      }),
    ).toEqual({kind: 'invalid', reason: 'invalidWalletIntervalWindow'});
  });
});
