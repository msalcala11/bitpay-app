import type {FiatRatePoint} from '../../../core/fiatRatesShared';
import type {WeightedGroupRateConstituentInput} from '../../compute/weightedGroupRates';

export const ORACLE_TS = {
  start: Date.parse('2024-01-01T00:00:00Z'),
  middle: Date.parse('2024-01-01T12:00:00Z'),
  end: Date.parse('2024-01-02T00:00:00Z'),
} as const;

export const NO_TRANSACTION_PARITY_FIXTURE = {
  interval: '1D',
  baselineUnits: 2,
  ratePoints: [
    {ts: ORACLE_TS.start, rate: 100},
    {ts: ORACLE_TS.end, rate: 125},
  ] satisfies readonly FiatRatePoint[],
  expected: {
    fiatStart: 200,
    fiatEnd: 250,
    pnlChange: 50,
    pnlPercent: 25,
    ratePercent: 25,
  },
} as const;

export const IN_WINDOW_BUY_FIXTURE = {
  interval: '1D',
  baselineUnits: 1,
  ratePoints: [
    {ts: ORACLE_TS.start, rate: 100},
    {ts: ORACLE_TS.middle, rate: 110},
    {ts: ORACLE_TS.end, rate: 130},
  ] satisfies readonly FiatRatePoint[],
  balanceEvents: [{ts: ORACLE_TS.middle, unitsDelta: 1, order: 1}],
  expected: {
    finalRemainingCostBasisFiat: 210,
    fiatEnd: 260,
    pnlChange: 50,
    pnlPercent: (50 / 210) * 100,
  },
} as const;

export const MID_SERIES_MUTATION_FIXTURE = {
  baselineUnits: 1,
  ratePoints: {
    base: [
      {ts: ORACLE_TS.start, rate: 100},
      {ts: ORACLE_TS.middle, rate: 110},
      {ts: ORACLE_TS.end, rate: 120},
    ] satisfies readonly FiatRatePoint[],
    middleChanged: [
      {ts: ORACLE_TS.start, rate: 100},
      {ts: ORACLE_TS.middle, rate: 115},
      {ts: ORACLE_TS.end, rate: 120},
    ] satisfies readonly FiatRatePoint[],
  },
} as const;

export const WEIGHTED_GROUP_FIXTURE = {
  quoteCurrency: 'USD',
  assetGroupId: 'usdc',
  walletIdsKey: 'wallet-a|wallet-b',
  interval: '1D',
  windowStartTs: 1,
  windowEndTs: 2,
  sampledFromStoredInterval: '1D',
  constituents: [
    {
      rateSourceKey: 'eth-usdc',
      baselineUnits: 100,
      points: [
        {ts: 1, rate: 1, percentChange: 0},
        {ts: 2, rate: 1.002, percentChange: 0.19999999999997797},
      ],
    },
    {
      rateSourceKey: 'pol-usdc',
      baselineUnits: 40,
      points: [
        {ts: 1, rate: 1.005, percentChange: 0},
        {ts: 2, rate: 1.006, percentChange: 0.09950248756219348},
      ],
    },
    {
      rateSourceKey: 'sol-usdc',
      baselineUnits: 40,
      points: [
        {ts: 1, rate: 1.0048, percentChange: 0},
        {ts: 2, rate: 1.0038, percentChange: -0.0995222929936251},
      ],
    },
  ] satisfies readonly WeightedGroupRateConstituentInput[],
  expected: {
    memberRateSourceKeys: ['eth-usdc', 'pol-usdc', 'sol-usdc'],
    baselineUnitsByRateSourceKey: {
      'eth-usdc': 100,
      'pol-usdc': 40,
      'sol-usdc': 40,
    },
    baselineUnits: 180,
    groupIndexStart: 180.392,
    groupIndexEnd: 180.592,
    weightedRateStart: 180.392 / 180,
    weightedRateEnd: 180.592 / 180,
    weightedPercentEnd: ((180.592 - 180.392) / 180.392) * 100,
  },
} as const;

export const WEIGHTED_ZERO_BASELINE_FIXTURE = {
  constituents: [
    {rateSourceKey: 'eth-usdc', baselineUnits: 0, points: []},
    {rateSourceKey: 'pol-usdc', baselineUnits: 0, points: []},
  ] satisfies readonly WeightedGroupRateConstituentInput[],
  expected: {
    unavailableReason: 'zeroBaseline',
    memberRateSourceKeys: ['eth-usdc', 'pol-usdc'],
    baselineUnitsByRateSourceKey: {
      'eth-usdc': 0,
      'pol-usdc': 0,
    },
  },
} as const;

export const WEIGHTED_MISSING_CONSTITUENT_FIXTURE = {
  constituents: [
    {
      rateSourceKey: 'eth-usdc',
      baselineUnits: 2,
      points: [
        {ts: 1, rate: 1, percentChange: 0},
        {ts: 2, rate: 1.2, percentChange: 19.999999999999996},
      ],
    },
    {rateSourceKey: 'pol-usdc', baselineUnits: 1, points: []},
  ] satisfies readonly WeightedGroupRateConstituentInput[],
  expected: {
    unavailableReason: 'missingConstituentRate',
  },
} as const;

export const TRANSFER_NON_NETTING_FIXTURES = {
  sameChainUsdc: {
    baselineUnits: {
      source: 100,
      destination: 0,
    },
    baselineRate: 1,
    sourceTransferUnits: 40,
    destinationSpotRate: 1.005,
    expected: {
      sourceUnitsEnd: 60,
      sourceRemainingCostBasisFiatEnd: 60,
      destinationUnitsEnd: 40,
      destinationRemainingCostBasisFiatEnd: 40.2,
      aggregateRemainingCostBasisFiatEnd: 100.2,
    },
  },
  crossChainUsdc: {
    baselineUnits: {
      source: 100,
      destination: 0,
    },
    sourceBaselineRate: 1,
    sourceTransferUnits: 40,
    destinationSpotRate: 1.0048,
    expected: {
      sourceRemainingCostBasisFiatEnd: 60,
      destinationRemainingCostBasisFiatEnd: 40.192,
      aggregateRemainingCostBasisFiatEnd: 100.192,
    },
  },
} as const;
