import {buildPortfolioComputedState} from './portfolioState';
import {
  buildFormulaComputedInputs,
  type BuildFormulaComputedInputsResult,
  type FormulaWalletIntervalInput,
} from './recomputeFormula';
import {
  IN_WINDOW_BUY_FIXTURE,
  NO_TRANSACTION_PARITY_FIXTURE,
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
});
