import {
  recomputePortfolioState,
  type FormulaWalletIntervalInput,
  type NormalizedFormulaRecomputeInput,
} from './recompute';
import {
  EMPTY_PORTFOLIO_STATE,
  type PortfolioState,
  type ScopeReadiness,
  type ScopedPortfolioSlice,
} from './model';
import {
  IN_WINDOW_BUY_FIXTURE,
  NO_TRANSACTION_PARITY_FIXTURE,
  ORACLE_TS,
} from './__tests__/fixtures/productOracles';

const READY_SCOPE: ScopeReadiness = {
  empty: false,
  hasEverPublishedValidSeries: true,
  initialScopeReady: true,
  refreshing: false,
  invalidHistoryBlocked: false,
};

function makeCurrentState(
  overrides: Partial<PortfolioState> = {},
): PortfolioState {
  return {
    ...EMPTY_PORTFOLIO_STATE,
    workEpoch: 7,
    revision: 4,
    quoteCurrency: 'USD',
    computedAtMs: 50,
    populatedWalletIdsKey: 'eth-wallet',
    populatedWalletIdsById: {'eth-wallet': true},
    readinessByScopeKey: {home: READY_SCOPE},
    ...overrides,
  };
}

function makePreviousScopedSlice(
  overrides: Partial<ScopedPortfolioSlice> = {},
): ScopedPortfolioSlice {
  return {
    walletIdsKey: 'eth-wallet',
    walletIds: ['eth-wallet'],
    fingerprint: 'scoped:previous',
    computedAtMs: 25,
    readiness: READY_SCOPE,
    total: {},
    totalFingerprint: 'total:previous',
    byAssetGroup: {},
    rowShells: [],
    orderedAssetGroupIdsForAssetList: [],
    invalidHistoryWalletIdsById: {},
    invalidHistoryAssetGroupIdsById: {},
    lastAccessedAt: 25,
    ...overrides,
  };
}

function oneDayInterval(
  overrides: Partial<FormulaWalletIntervalInput> = {},
): FormulaWalletIntervalInput {
  return {
    interval: '1D',
    seriesIdentityKey: 'wallet:eth|asset:eth|quote:USD|snap:1|rate:1',
    windowStartTs: ORACLE_TS.start,
    windowEndTs: ORACLE_TS.end,
    sampledFromStoredInterval: '1D',
    finalPointSource: 'historicalRate',
    baselineUnits: NO_TRANSACTION_PARITY_FIXTURE.baselineUnits,
    ratePoints: NO_TRANSACTION_PARITY_FIXTURE.ratePoints,
    maxPoints: 2,
    ...overrides,
  };
}

function normalizedInput(
  overrides: Partial<NormalizedFormulaRecomputeInput> = {},
): NormalizedFormulaRecomputeInput {
  return {
    computedAtMs: 100,
    populatedWalletIds: ['eth-wallet'],
    formula: {
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
    },
    ...overrides,
  };
}

describe('portfolio v2 recompute entrypoint', () => {
  it('builds the next portfolio state from normalized formula inputs', () => {
    const current = makeCurrentState();
    const next = recomputePortfolioState(current, {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    expect(next).not.toBe(current);
    expect(next).toMatchObject({
      workEpoch: 7,
      revision: 5,
      quoteCurrency: 'USD',
      computedAtMs: 100,
      populatedWalletIdsKey: 'eth-wallet',
    });
    expect(next.byWallet['eth-wallet'].rowToday).toMatchObject({
      fiatStart: 200,
      fiatEnd: 250,
      pnlChange: 50,
      pnlPercent: 25,
      ratePercent: 25,
    });
    expect(next.byAssetGroup.eth.rowToday).toEqual(next.rowShells[0].rowToday);
    expect(next.status).toMatchObject({
      invalidHistoryWalletIds: [],
      missingRateSourceKeys: [],
    });
  });

  it('preserves previous readiness and scoped cache context across pure recompute', () => {
    const previousScoped = makePreviousScopedSlice();
    const current = makeCurrentState({
      scopedByWalletSet: {'eth-wallet': previousScoped},
    });
    const next = recomputePortfolioState(current, {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    expect(next.readinessByScopeKey.home.hasEverPublishedValidSeries).toBe(
      true,
    );
    expect(next.scopedByWalletSet['eth-wallet']).toBe(previousScoped);
  });

  it('returns the current state for stale epochs or invalid normalized inputs', () => {
    const current = makeCurrentState();

    expect(
      recomputePortfolioState(current, {
        scope: 'full',
        startEpoch: 6,
        normalizedFormulaInput: normalizedInput(),
      }),
    ).toBe(current);
    expect(
      recomputePortfolioState(current, {
        scope: 'full',
        startEpoch: 7,
        normalizedFormulaInput: normalizedInput({
          formula: {
            quoteCurrency: ' USD',
            wallets: [],
            assetGroups: [],
          },
        }),
      }),
    ).toBe(current);
  });

  it('does not treat non-full scopes as full formula recompute in Phase 3g', () => {
    const current = makeCurrentState();
    const next = recomputePortfolioState(current, {
      scope: {kind: 'wallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    expect(next).toBe(current);
  });

  it('touches wallet access metadata without rebuilding computed series', () => {
    const built = recomputePortfolioState(makeCurrentState(), {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    const previousScoped = makePreviousScopedSlice({
      rowShells: built.rowShells,
      byAssetGroup: built.byAssetGroup,
      lastAccessedAt: 25,
      computedAtMs: 25,
    });
    const current = {
      ...built,
      scopedByWalletSet: {'eth-wallet': previousScoped},
    };
    const originalWallet = current.byWallet['eth-wallet'];
    const next = recomputePortfolioState(current, {
      scope: {kind: 'touchWallet', walletId: 'eth-wallet'},
      startEpoch: 7,
      computedAtMs: 200,
    });

    expect(next).not.toBe(current);
    expect(next.revision).toBe(current.revision + 1);
    expect(next.computedAtMs).toBe(current.computedAtMs);
    expect(next.rowShells).toBe(current.rowShells);
    expect(next.byWallet['eth-wallet']).toMatchObject({
      lastAccessedAt: 200,
      lastWrittenAt: originalWallet.lastWrittenAt,
      fingerprint: originalWallet.fingerprint,
    });
    expect(next.byWallet['eth-wallet'].series).toBe(originalWallet.series);
    expect(next.scopedByWalletSet['eth-wallet']).toMatchObject({
      lastAccessedAt: 200,
      computedAtMs: 25,
      fingerprint: 'scoped:previous',
    });
  });

  it('updates live-rate row-shell surfaces without rebuilding historical state', () => {
    const built = recomputePortfolioState(makeCurrentState(), {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });
    const previousScoped = makePreviousScopedSlice({
      rowShells: built.rowShells,
      byAssetGroup: built.byAssetGroup,
      lastAccessedAt: 25,
      computedAtMs: 25,
    });
    const current = {
      ...built,
      scopedByWalletSet: {'eth-wallet': previousScoped},
    };
    const originalWallet = current.byWallet['eth-wallet'];
    const originalAssetGroup = current.byAssetGroup.eth;
    const originalRowToday = current.rowShells[0].rowToday;
    const baseInput = normalizedInput();
    const next = recomputePortfolioState(current, {
      scope: {kind: 'liveRateTouch', changedAssetIds: ['eth']},
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        computedAtMs: 225,
        formula: {
          ...baseInput.formula,
          wallets: [
            {
              ...baseInput.formula.wallets[0],
              displayUnitsAtomic: '3000000000000000000',
              liveRate: 130,
            },
          ],
        },
      }),
    });

    expect(next).not.toBe(current);
    expect(next.revision).toBe(current.revision + 1);
    expect(next.computedAtMs).toBe(225);
    expect(next.byWallet['eth-wallet']).toBe(originalWallet);
    expect(next.byAssetGroup.eth).toBe(originalAssetGroup);
    expect(next.totalFingerprint).toBe(current.totalFingerprint);
    expect(next.rowShells[0]).toMatchObject({
      assetGroupId: 'eth',
      currentCryptoAmount: '3',
      currentFiatValue: 390,
    });
    expect(next.rowShells[0].rowToday).toBe(originalRowToday);
    expect(next.scopedByWalletSet['eth-wallet']).toMatchObject({
      lastAccessedAt: 25,
      computedAtMs: 25,
    });
    expect(next.scopedByWalletSet['eth-wallet'].rowShells[0]).toMatchObject({
      currentCryptoAmount: '3',
      currentFiatValue: 390,
    });
  });

  it('returns the current state when final state assembly rejects the request', () => {
    const current = makeCurrentState();
    const next = recomputePortfolioState(current, {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        scopes: [
          {
            scopeKey: 'missing-wallet',
            walletIds: ['missing-wallet'],
          },
        ],
      }),
    });

    expect(next).toBe(current);
  });

  it('preserves existing invalid-history wallet ids when formula adds none', () => {
    const current = makeCurrentState({
      invalidHistoryWalletIdsKey: 'legacy-invalid-wallet',
      invalidHistoryWalletIdsById: {'legacy-invalid-wallet': true},
    });
    const next = recomputePortfolioState(current, {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput(),
    });

    expect(next).not.toBe(current);
    expect(next.invalidHistoryWalletIdsKey).toBe('legacy-invalid-wallet');
    expect(next.status.invalidHistoryWalletIds).toEqual([
      'legacy-invalid-wallet',
    ]);
  });

  it('allows normalized input to explicitly clear previous invalid-history wallet ids', () => {
    const current = makeCurrentState({
      invalidHistoryWalletIdsKey: 'legacy-invalid-wallet',
      invalidHistoryWalletIdsById: {'legacy-invalid-wallet': true},
    });
    const next = recomputePortfolioState(current, {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        invalidHistoryWalletIds: [],
      }),
    });

    expect(next).not.toBe(current);
    expect(next.invalidHistoryWalletIdsKey).toBe('');
    expect(next.invalidHistoryWalletIdsById).toEqual({});
    expect(next.status.invalidHistoryWalletIds).toEqual([]);
  });

  it('uses explicit invalid-history ids as the replacement seed and unions formula-invalid wallets', () => {
    const current = makeCurrentState({
      invalidHistoryWalletIdsKey: 'legacy-invalid-wallet',
      invalidHistoryWalletIdsById: {'legacy-invalid-wallet': true},
    });
    const next = recomputePortfolioState(current, {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        invalidHistoryWalletIds: ['explicit-invalid-wallet'],
        formula: {
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
                oneDayInterval({
                  baselineUnits: 1,
                  balanceEvents: [
                    {ts: ORACLE_TS.middle, unitsDelta: -2, order: 1},
                  ],
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
        },
      }),
    });

    expect(next).not.toBe(current);
    expect(next.status.invalidHistoryWalletIds).toEqual([
      'eth-wallet',
      'explicit-invalid-wallet',
    ]);
    expect(next.invalidHistoryWalletIdsKey).toBe(
      'eth-wallet|explicit-invalid-wallet',
    );
    expect(next.invalidHistoryWalletIdsById).toEqual({
      'eth-wallet': true,
      'explicit-invalid-wallet': true,
    });
  });

  it('surfaces formula invalid-history and missing-rate status through final state', () => {
    const invalidHistory = recomputePortfolioState(makeCurrentState(), {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        formula: {
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
                oneDayInterval({
                  baselineUnits: 1,
                  balanceEvents: [
                    {ts: ORACLE_TS.middle, unitsDelta: -2, order: 1},
                  ],
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
        },
      }),
    });
    const missingRate = recomputePortfolioState(makeCurrentState(), {
      scope: 'full',
      startEpoch: 7,
      normalizedFormulaInput: normalizedInput({
        formula: {
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
                oneDayInterval({
                  baselineUnits: IN_WINDOW_BUY_FIXTURE.baselineUnits,
                  balanceEvents: IN_WINDOW_BUY_FIXTURE.balanceEvents,
                  ratePoints: [
                    {ts: ORACLE_TS.start, rate: 100},
                    {ts: ORACLE_TS.middle - 1, rate: 110},
                  ],
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
        },
      }),
    });

    expect(invalidHistory.status.invalidHistoryWalletIds).toEqual([
      'eth-wallet',
    ]);
    expect(invalidHistory.byWallet['eth-wallet'].series).toEqual({});
    expect(invalidHistory.rowShells[0].invalidHistoryBlocked).toBe(true);
    expect(missingRate.status.missingRateSourceKeys).toEqual(['eth']);
    expect(missingRate.byWallet['eth-wallet'].rowToday).toBeUndefined();
  });
});
