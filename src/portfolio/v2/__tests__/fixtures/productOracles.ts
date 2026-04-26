import type {FiatRatePoint} from '../../../core/fiatRatesShared';

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
