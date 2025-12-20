import moment from 'moment';
import {createSelector} from 'reselect';
import {AppSelector, RootState} from '..';
import {
  PortfolioTx,
  readRateMap,
  readTxRateMap,
  readTsRateMap,
  readWalletTxs,
} from './portfolio.storage';
import {Rates} from '../rate/rate.models';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../constants/currencies';
import {tokenManager} from '../../managers/TokenManager';
import {getCurrencyAbbreviation, getRateByCurrencyName} from '../../utils/helper-methods';

const createSelectorLoose: any = createSelector;

type UnitInfo = {
  unitToSatoshi: number;
  unitDecimals: number;
};

export type PortfolioAssetKey = string;

export type PortfolioPosition = {
  assetKey: PortfolioAssetKey;
  chain: string;
  coin: string;
  tokenAddress?: string;
  rateSymbol: string;
  units: number;
  costBasisFiat: number;
  missingRates: boolean;
};

export type PortfolioAssetRow = PortfolioPosition & {
  currentRate?: number;
  valueFiat: number;
  pnlFiat: number;
  allocation: number;
  intervalPnlFiat?: number;
  intervalPnlPct?: number;
};

export type PortfolioAssetList = {
  totalValueFiat: number;
  totalCostBasisFiat: number;
  totalPnlFiat: number;
  totalIntervalPnlFiat?: number;
  missingRates: boolean;
  assets: PortfolioAssetRow[];
};

export type PortfolioInterval = '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';

export type PortfolioChartPoint = {
  ts: number;
  value: number;
  breakeven: number;
  pnl: number;
};

export type PortfolioChartSeries = {
  interval: PortfolioInterval;
  points: PortfolioChartPoint[];
  missingRates: boolean;
};

type PortfolioEvent = {
  txid: string;
  time: number;
  assetKey: PortfolioAssetKey;
  chain: string;
  coin: string;
  tokenAddress?: string;
  rateSymbol: string;
  deltaUnits: number;
  isInternalTransferCandidate: boolean;
};

type TokensDataByAddress = Record<string, {coin?: string; unitInfo?: UnitInfo}>;

const buildTokensDataByAddress = (state: RootState) => {
  const {
    WALLET: {customTokenDataByAddress},
  } = state;

  const {tokenDataByAddress} = tokenManager.getTokenOptions();

  return {
    ...tokenDataByAddress,
    ...customTokenDataByAddress,
    ...BitpaySupportedTokens,
  } as Record<string, {coin?: string; unitInfo?: UnitInfo}>;
};

const selectTokensDataByAddress = createSelectorLoose(
  (state: RootState) => state.WALLET.customTokenDataByAddress,
  (customTokenDataByAddress: any) => {
    const {tokenDataByAddress} = tokenManager.getTokenOptions();
    return {
      ...tokenDataByAddress,
      ...customTokenDataByAddress,
      ...BitpaySupportedTokens,
    } as TokensDataByAddress;
  },
);

const getUnitInfo = (
  tokens: Record<string, {coin?: string; unitInfo?: UnitInfo}>,
  {
    chain,
    tokenAddress,
  }: {
    chain: string;
    tokenAddress?: string;
  },
): UnitInfo | undefined => {
  if (tokenAddress) {
    const currencyName = getCurrencyAbbreviation(tokenAddress, chain);
    return tokens[currencyName]?.unitInfo;
  }

  return BitpaySupportedCoins[chain]?.unitInfo as UnitInfo | undefined;
};

const getRateSymbol = (
  tokens: Record<string, {coin?: string; unitInfo?: UnitInfo}>,
  {
    chain,
    coin,
    tokenAddress,
  }: {
    chain: string;
    coin: string;
    tokenAddress?: string;
  },
): string => {
  if (tokenAddress) {
    const currencyName = getCurrencyAbbreviation(tokenAddress, chain);
    const symbol = tokens[currencyName]?.coin;
    if (typeof symbol === 'string' && symbol.length > 0) {
      return symbol.toLowerCase();
    }
  }

  switch (coin.toLowerCase()) {
    case 'wbtc':
      return 'btc';
    case 'weth':
      return 'eth';
    default:
      return coin.toLowerCase();
  }
};

const getAssetKey = ({
  chain,
  coin,
  tokenAddress,
}: {
  chain: string;
  coin: string;
  tokenAddress?: string;
}): PortfolioAssetKey => {
  const id = tokenAddress ? tokenAddress.toLowerCase() : coin.toLowerCase();
  return `${chain}:${id}`;
};

const satToUnit = (amountSat: number, unitToSatoshi: number): number => {
  if (!amountSat || !unitToSatoshi) {
    return 0;
  }
  return amountSat / unitToSatoshi;
};

const applyDeltaUnits = (
  position: PortfolioPosition,
  deltaUnits: number,
  fiatRateForBuy?: number,
) => {
  if (!deltaUnits) {
    return;
  }

  if (deltaUnits > 0) {
    position.units += deltaUnits;
    if (fiatRateForBuy != null) {
      position.costBasisFiat += deltaUnits * fiatRateForBuy;
    } else {
      position.missingRates = true;
    }
    return;
  }

  const disposed = Math.abs(deltaUnits);
  if (position.units <= 0 || position.costBasisFiat <= 0) {
    position.units = Math.max(0, position.units - disposed);
    position.costBasisFiat = Math.max(0, position.costBasisFiat);
    return;
  }

  const avgCostPerUnit = position.costBasisFiat / position.units;
  position.units = Math.max(0, position.units - disposed);
  position.costBasisFiat = Math.max(0, position.costBasisFiat - disposed * avgCostPerUnit);
};

const buildEventsForWalletTxs = (
  tokens: Record<string, {coin?: string; unitInfo?: UnitInfo}>,
  {
    txs,
  }: {
    txs: PortfolioTx[];
  },
): PortfolioEvent[] => {
  const events: PortfolioEvent[] = [];

  for (const tx of txs) {
    const chain = tx.chain || '';
    const coin = tx.coin || '';
    if (!chain || !coin || !tx.txid) {
      continue;
    }

    const tokenAddress = tx.tokenAddress || undefined;
    const action = tx.action;

    const unitInfo = getUnitInfo(tokens, {chain, tokenAddress});
    if (!unitInfo?.unitToSatoshi) {
      continue;
    }

    const rateSymbol = getRateSymbol(tokens, {chain, coin, tokenAddress});
    const assetKey = getAssetKey({chain, coin, tokenAddress});

    const amountSat = typeof tx.amount === 'number' ? tx.amount : 0;
    const amountUnits = satToUnit(amountSat, unitInfo.unitToSatoshi);

    if (amountUnits) {
      if (action === 'received') {
        events.push({
          txid: tx.txid,
          time: tx.time,
          assetKey,
          chain,
          coin,
          tokenAddress,
          rateSymbol,
          deltaUnits: amountUnits,
          isInternalTransferCandidate: true,
        });
      } else if (action === 'sent') {
        events.push({
          txid: tx.txid,
          time: tx.time,
          assetKey,
          chain,
          coin,
          tokenAddress,
          rateSymbol,
          deltaUnits: -amountUnits,
          isInternalTransferCandidate: true,
        });
      }
    }

    const feeSat =
      typeof tx.fees === 'number'
        ? tx.fees
        : typeof tx.fee === 'number'
        ? tx.fee
        : 0;

    if (feeSat && (action === 'sent' || action === 'moved')) {
      const feeCurrency = BitpaySupportedCoins[chain]?.feeCurrency || coin;
      const feeUnitInfo = getUnitInfo(tokens, {chain, tokenAddress: undefined});
      if (feeUnitInfo?.unitToSatoshi) {
        const feeUnits = satToUnit(feeSat, feeUnitInfo.unitToSatoshi);
        if (feeUnits) {
          const feeAssetKey = getAssetKey({
            chain,
            coin: feeCurrency,
            tokenAddress: undefined,
          });
          const feeRateSymbol = getRateSymbol(tokens, {
            chain,
            coin: feeCurrency,
            tokenAddress: undefined,
          });
          events.push({
            txid: tx.txid,
            time: tx.time,
            assetKey: feeAssetKey,
            chain,
            coin: feeCurrency,
            tokenAddress: undefined,
            rateSymbol: feeRateSymbol,
            deltaUnits: -feeUnits,
            isInternalTransferCandidate: false,
          });
        }
      }
    }
  }

  return events;
};

const neutralizeInternalTransfers = (events: PortfolioEvent[]): PortfolioEvent[] => {
  const byKey: Record<string, PortfolioEvent[]> = {};

  for (const e of events) {
    if (!e.isInternalTransferCandidate) {
      continue;
    }
    const k = `${e.txid}:${e.assetKey}`;
    (byKey[k] ||= []).push(e);
  }

  const suppressed = new Set<PortfolioEvent>();

  for (const group of Object.values(byKey)) {
    if (group.length < 2) {
      continue;
    }
    let hasPositive = false;
    let hasNegative = false;
    for (const e of group) {
      if (e.deltaUnits > 0) {
        hasPositive = true;
      }
      if (e.deltaUnits < 0) {
        hasNegative = true;
      }
    }
    if (hasPositive && hasNegative) {
      for (const e of group) {
        suppressed.add(e);
      }
    }
  }

  return events.filter(e => !suppressed.has(e));
};

const computePositionsFromEvents = (
  {
    fiatCode,
    events,
  }: {
    fiatCode: string;
    events: PortfolioEvent[];
  },
): Record<PortfolioAssetKey, PortfolioPosition> => {
  const symbols = Array.from(new Set(events.map(e => e.rateSymbol)));
  const rateMaps: Record<string, Record<string, number>> = {};
  const txRateMaps: Record<string, Record<string, number>> = {};
  for (const s of symbols) {
    rateMaps[s] = readRateMap(fiatCode, s);
    txRateMaps[s] = readTxRateMap(fiatCode, s);
  }

  const sorted = [...events].sort((a, b) => a.time - b.time);

  const positions: Record<PortfolioAssetKey, PortfolioPosition> = {};

  for (const e of sorted) {
    const pos = (positions[e.assetKey] ||= {
      assetKey: e.assetKey,
      chain: e.chain,
      coin: e.coin,
      tokenAddress: e.tokenAddress,
      rateSymbol: e.rateSymbol,
      units: 0,
      costBasisFiat: 0,
      missingRates: false,
    });

    let rate: number | undefined;
    if (e.deltaUnits > 0) {
      const txRate = txRateMaps[e.rateSymbol]?.[`${e.chain}:${e.txid}`];
      if (txRate != null) {
        rate = txRate;
      } else {
        const dayKey = String(moment(e.time).startOf('day').valueOf());
        rate = rateMaps[e.rateSymbol]?.[dayKey];
      }
    }

    applyDeltaUnits(pos, e.deltaUnits, rate);
  }

  return positions;
};

const getCurrentFiatRate = (
  rates: Rates,
  fiatCode: string,
  {
    coin,
    chain,
    tokenAddress,
  }: {
    coin: string;
    chain: string;
    tokenAddress?: string;
  },
): number | undefined => {
  const arr = getRateByCurrencyName(rates, coin, chain, tokenAddress);
  const match = arr?.find(r => r.code?.toUpperCase() === fiatCode.toUpperCase());
  return match?.rate;
};

const buildAssetListFromPositions = (
  currentRates: Rates,
  {
    fiatCode,
    positions,
  }: {
    fiatCode: string;
    positions: Record<PortfolioAssetKey, PortfolioPosition>;
  },
): PortfolioAssetList => {
  const rows: PortfolioAssetRow[] = [];

  let totalValueFiat = 0;
  let totalCostBasisFiat = 0;
  let missingRates = false;

  for (const p of Object.values(positions)) {
    if (!p.units) {
      continue;
    }
    const currentRate = getCurrentFiatRate(currentRates, fiatCode, p);
    const valueFiat = currentRate != null ? p.units * currentRate : 0;
    if (currentRate == null) {
      missingRates = true;
    }
    totalValueFiat += valueFiat;
    totalCostBasisFiat += p.costBasisFiat;
    rows.push({
      ...p,
      currentRate,
      valueFiat,
      pnlFiat: valueFiat - p.costBasisFiat,
      allocation: 0,
    });
  }

  const totalPnlFiat = totalValueFiat - totalCostBasisFiat;

  const assets = rows
    .map(r => ({
      ...r,
      allocation: totalValueFiat > 0 ? r.valueFiat / totalValueFiat : 0,
    }))
    .sort((a, b) => b.valueFiat - a.valueFiat);

  return {
    totalValueFiat,
    totalCostBasisFiat,
    totalPnlFiat,
    missingRates: missingRates || assets.some(a => a.missingRates),
    assets,
  };
};

const buildRateMapsForEvents = (
  fiatCode: string,
  events: PortfolioEvent[],
): Record<string, Record<string, number>> => {
  const symbols = Array.from(new Set(events.map(e => e.rateSymbol)));
  const rateMaps: Record<string, Record<string, number>> = {};
  for (const s of symbols) {
    rateMaps[s] = readRateMap(fiatCode, s);
  }
  return rateMaps;
};

const computePositionsSnapshotFromEvents = (
  {
    fiatCode,
    events,
    cutoffTs,
    inclusive,
  }: {
    fiatCode: string;
    events: PortfolioEvent[];
    cutoffTs: number;
    inclusive: boolean;
  },
): Record<PortfolioAssetKey, PortfolioPosition> => {
  const rateMaps = buildRateMapsForEvents(fiatCode, events);
  const symbols = Array.from(new Set(events.map(e => e.rateSymbol)));
  const txRateMaps: Record<string, Record<string, number>> = {};
  for (const s of symbols) {
    txRateMaps[s] = readTxRateMap(fiatCode, s);
  }
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const positions: Record<PortfolioAssetKey, PortfolioPosition> = {};

  for (const e of sorted) {
    const within = inclusive ? e.time <= cutoffTs : e.time < cutoffTs;
    if (!within) {
      break;
    }

    const pos = (positions[e.assetKey] ||= {
      assetKey: e.assetKey,
      chain: e.chain,
      coin: e.coin,
      tokenAddress: e.tokenAddress,
      rateSymbol: e.rateSymbol,
      units: 0,
      costBasisFiat: 0,
      missingRates: false,
    });

    let rate: number | undefined;
    if (e.deltaUnits > 0) {
      const txRate = txRateMaps[e.rateSymbol]?.[`${e.chain}:${e.txid}`];
      if (txRate != null) {
        rate = txRate;
      } else {
        const dayKey = String(moment(e.time).startOf('day').valueOf());
        rate = rateMaps[e.rateSymbol]?.[dayKey];
      }
    }

    applyDeltaUnits(pos, e.deltaUnits, rate);
  }

  return positions;
};

const getHistoricValueForPositions = (
  rateMaps: Record<string, Record<string, number>>,
  dayKey: string,
  positions: Record<PortfolioAssetKey, PortfolioPosition>,
): {valueFiat: number; missingRates: boolean} => {
  let valueFiat = 0;
  let missingRates = false;
  for (const p of Object.values(positions)) {
    if (!p.units) {
      continue;
    }
    const r = rateMaps[p.rateSymbol]?.[dayKey];
    if (r == null) {
      missingRates = true;
      continue;
    }
    valueFiat += p.units * r;
  }
  return {valueFiat, missingRates};
};

const buildAssetListWithIntervalPnlFromEvents = (
  currentRates: Rates,
  {
    fiatCode,
    interval,
    events,
  }: {
    fiatCode: string;
    interval: PortfolioInterval;
    events: PortfolioEvent[];
  },
): PortfolioAssetList => {
  const endTs = Date.now();
  const {startTs} = resolveIntervalWindow(interval, events);

  const endPositions = computePositionsSnapshotFromEvents({
    fiatCode,
    events,
    cutoffTs: endTs,
    inclusive: true,
  });

  const startPositions = computePositionsSnapshotFromEvents({
    fiatCode,
    events,
    cutoffTs: startTs,
    inclusive: false,
  });

  const list = buildAssetListFromPositions(currentRates, {
    fiatCode,
    positions: endPositions,
  });

  const rateMaps = buildRateMapsForEvents(fiatCode, events);
  const startDayKey = String(moment(startTs).startOf('day').valueOf());
  const {valueFiat: startValueFiat, missingRates: startMissingRates} =
    getHistoricValueForPositions(rateMaps, startDayKey, startPositions);

  const startCostBasisFiat = Object.values(startPositions).reduce(
    (sum, p) => sum + (p.units ? p.costBasisFiat : 0),
    0,
  );

  const startPnlFiat = startValueFiat - startCostBasisFiat;

  const assets = list.assets.map(a => {
    const startPos = startPositions[a.assetKey];
    const startCost = startPos?.units ? startPos.costBasisFiat : 0;
    const startUnits = startPos?.units || 0;
    const startRate = rateMaps[a.rateSymbol]?.[startDayKey];
    const startValue = startRate != null ? startUnits * startRate : 0;
    const startPnl = startValue - startCost;
    const intervalPnlFiat = a.pnlFiat - startPnl;
    const intervalPnlPct = startValue ? intervalPnlFiat / startValue : undefined;
    return {
      ...a,
      intervalPnlFiat,
      intervalPnlPct,
    };
  });

  return {
    ...list,
    assets,
    totalIntervalPnlFiat: list.totalPnlFiat - startPnlFiat,
    missingRates: list.missingRates || startMissingRates,
  };
};

const resolveIntervalWindow = (
  interval: PortfolioInterval,
  events: PortfolioEvent[],
): {startTs: number; endTs: number; targetPoints: number; isIntraday: boolean} => {
  const now = moment();
  switch (interval) {
    case '1D':
      {
        const end = now.clone().startOf('hour');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(1, 'day').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: true,
        };
      }
    case '1W':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(7, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '1M':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(30, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '3M':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(90, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '1Y':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(365, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case '5Y':
      {
        const end = now.clone().startOf('day');
        const endTs = end.valueOf();
        return {
          startTs: end.clone().subtract(365 * 5, 'days').valueOf(),
          endTs,
          targetPoints: 45,
          isIntraday: false,
        };
      }
    case 'ALL': {
      const first = events.length
        ? Math.min(...events.map(e => e.time))
        : now.clone().startOf('day').valueOf();

      const end = now.clone().startOf('day');
      const endTs = end.valueOf();
      return {
        startTs: moment(first).startOf('day').valueOf(),
        endTs,
        targetPoints: 45,
        isIntraday: false,
      };
    }
  }
};

const computeSeriesFromEvents = ({
  fiatCode,
  interval,
  events,
}: {
  fiatCode: string;
  interval: PortfolioInterval;
  events: PortfolioEvent[];
}): PortfolioChartSeries => {
  const {startTs, endTs, targetPoints} = resolveIntervalWindow(interval, events);

  const sorted = [...events]
    .filter(e => e.time <= endTs)
    .sort((a, b) => a.time - b.time);

  const symbols = Array.from(new Set(sorted.map(e => e.rateSymbol)));
  const rateMaps: Record<string, Record<string, number>> = {};
  const txRateMaps: Record<string, Record<string, number>> = {};
  const tsRateMaps: Record<string, Record<string, number>> = {};
  for (const s of symbols) {
    rateMaps[s] = readRateMap(fiatCode, s);
    txRateMaps[s] = readTxRateMap(fiatCode, s);
    tsRateMaps[s] = readTsRateMap(fiatCode, s);
  }

  const positions: Record<PortfolioAssetKey, PortfolioPosition> = {};
  const ensurePos = (e: PortfolioEvent): PortfolioPosition => {
    return (positions[e.assetKey] ||= {
      assetKey: e.assetKey,
      chain: e.chain,
      coin: e.coin,
      tokenAddress: e.tokenAddress,
      rateSymbol: e.rateSymbol,
      units: 0,
      costBasisFiat: 0,
      missingRates: false,
    });
  };

  const applyEvent = (e: PortfolioEvent) => {
    const pos = ensurePos(e);
    let rate: number | undefined;
    if (e.deltaUnits > 0) {
      const txRateKey = `${e.chain}:${e.txid}`;
      const txRate = txRateMaps[e.rateSymbol]?.[txRateKey];
      if (txRate != null) {
        rate = txRate;
      } else {
        const dayKey = String(moment(e.time).startOf('day').valueOf());
        rate = rateMaps[e.rateSymbol]?.[dayKey];
      }
    }
    applyDeltaUnits(pos, e.deltaUnits, rate);
  };

  let idx = 0;
  while (idx < sorted.length && sorted[idx].time < startTs) {
    applyEvent(sorted[idx]);
    idx++;
  }

  const sampleTs: number[] = [];
  const step = (endTs - startTs) / Math.max(targetPoints - 1, 1);
  for (let i = 0; i < targetPoints; i++) {
    sampleTs.push(Math.round(startTs + step * i));
  }

  const points: PortfolioChartPoint[] = [];
  let missingRates = false;

  for (const ts of sampleTs) {
    while (idx < sorted.length && sorted[idx].time <= ts) {
      applyEvent(sorted[idx]);
      idx++;
    }

    const dayKey = String(moment(ts).startOf('day').valueOf());
    const tsKey = String(ts);
    let value = 0;
    let breakeven = 0;
    for (const p of Object.values(positions)) {
      if (!p.units) {
        breakeven += p.costBasisFiat;
        continue;
      }
      breakeven += p.costBasisFiat;
      const r =
        tsRateMaps[p.rateSymbol]?.[tsKey] ?? rateMaps[p.rateSymbol]?.[dayKey];
      if (r == null) {
        missingRates = true;
        continue;
      }
      value += p.units * r;
    }
    points.push({ts, value, breakeven, pnl: value - breakeven});
  }

  return {interval, points, missingRates};
};

export const selectPortfolioGlobalSync: AppSelector = ({PORTFOLIO}) =>
  PORTFOLIO.global;

export const selectPortfolioWalletsSync: AppSelector = ({PORTFOLIO}) =>
  PORTFOLIO.wallets;

export const makeSelectWalletEvents = (
  walletId: string,
): ((state: RootState) => PortfolioEvent[]) =>
  createSelectorLoose(
    (state: RootState) => state.PORTFOLIO.wallets[walletId]?.txCount || 0,
    selectTokensDataByAddress,
    (_txCount: number, tokens: TokensDataByAddress) => {
      const txs = readWalletTxs(walletId);
      return buildEventsForWalletTxs(tokens, {txs});
    },
  ) as ((state: RootState) => PortfolioEvent[]);

export const makeSelectWalletPositions = (
  walletId: string,
  fiatCode: string,
) : ((state: RootState) => Record<string, PortfolioPosition>) =>
  createSelectorLoose(
    makeSelectWalletEvents(walletId),
    (events: PortfolioEvent[]) => computePositionsFromEvents({fiatCode, events}),
  ) as ((state: RootState) => Record<string, PortfolioPosition>);

export const makeSelectWalletAssetList = (
  walletId: string,
  fiatCode: string,
): ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    makeSelectWalletPositions(walletId, fiatCode),
    (state: RootState) => state.RATE?.rates || {},
    (positions: Record<string, PortfolioPosition>, currentRates: any) =>
      buildAssetListFromPositions(currentRates as Rates, {fiatCode, positions}),
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectWalletAssetListByInterval = (
  walletId: string,
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    makeSelectWalletEvents(walletId),
    (state: RootState) => state.RATE?.rates || {},
    (events: PortfolioEvent[], currentRates: any) =>
      buildAssetListWithIntervalPnlFromEvents(currentRates as Rates, {
        fiatCode,
        interval,
        events,
      }),
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectWalletChartSeries = (
  walletId: string,
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioChartSeries) =>
  createSelectorLoose(
    makeSelectWalletEvents(walletId),
    (events: PortfolioEvent[]) => computeSeriesFromEvents({fiatCode, interval, events}),
  ) as ((state: RootState) => PortfolioChartSeries);

export const makeSelectAccountPositions = (
  keyId: string,
  accountKey: string,
  fiatCode: string,
) : ((state: RootState) => Record<string, PortfolioPosition>) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
    ],
    (key: any, walletSyncs: any, tokens: TokensDataByAddress) => {
      const wallets = (key as any)?.wallets || [];
      const selectedWalletIds: string[] = wallets
        .filter((w: any) => {
          const wAccountKey = w?.receiveAddress || w?.credentials?.walletId;
          return wAccountKey === accountKey;
        })
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = selectedWalletIds.flatMap(id => readWalletTxs(id));
      const events = buildEventsForWalletTxs(tokens, {txs: allTxs});
      return computePositionsFromEvents({fiatCode, events});
    },
  ) as ((state: RootState) => Record<string, PortfolioPosition>);

export const makeSelectAccountAssetList = (
  keyId: string,
  accountKey: string,
  fiatCode: string,
) : ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    makeSelectAccountPositions(keyId, accountKey, fiatCode),
    (state: RootState) => state.RATE?.rates || {},
    (positions: Record<string, PortfolioPosition>, currentRates: any) =>
      buildAssetListFromPositions(currentRates as Rates, {fiatCode, positions}),
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectAccountAssetListByInterval = (
  keyId: string,
  accountKey: string,
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
      (state: RootState) => state.RATE?.rates || {},
    ],
    (key: any, walletSyncs: any, tokens: TokensDataByAddress, currentRates: any) => {
      const wallets = (key as any)?.wallets || [];
      const selectedWalletIds: string[] = wallets
        .filter((w: any) => {
          const wAccountKey = w?.receiveAddress || w?.credentials?.walletId;
          return wAccountKey === accountKey;
        })
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = selectedWalletIds.flatMap(id => readWalletTxs(id));
      const events = buildEventsForWalletTxs(tokens, {txs: allTxs});
      return buildAssetListWithIntervalPnlFromEvents(currentRates as Rates, {
        fiatCode,
        interval,
        events,
      });
    },
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectAccountChartSeries = (
  keyId: string,
  accountKey: string,
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioChartSeries) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
    ],
    (key: any, walletSyncs: any, tokens: TokensDataByAddress) => {
      const wallets = (key as any)?.wallets || [];
      const selectedWalletIds: string[] = wallets
        .filter((w: any) => {
          const wAccountKey = w?.receiveAddress || w?.credentials?.walletId;
          return wAccountKey === accountKey;
        })
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = selectedWalletIds.flatMap(id => readWalletTxs(id));
      const events = buildEventsForWalletTxs(tokens, {txs: allTxs});
      return computeSeriesFromEvents({fiatCode, interval, events});
    },
  ) as ((state: RootState) => PortfolioChartSeries);

export const makeSelectKeyPositions = (
  keyId: string,
  fiatCode: string,
): ((state: RootState) => Record<string, PortfolioPosition>) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
    ],
    (key: any, walletSyncs: any, tokens: TokensDataByAddress) => {
      const wallets = (key as any)?.wallets || [];
      const syncedWalletIds: string[] = wallets
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));

      const rawEvents = buildEventsForWalletTxs(tokens, {txs: allTxs});
      const events = neutralizeInternalTransfers(rawEvents);
      return computePositionsFromEvents({fiatCode, events});
    },
  ) as ((state: RootState) => Record<string, PortfolioPosition>);

export const makeSelectKeyAssetList = (
  keyId: string,
  fiatCode: string,
): ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    makeSelectKeyPositions(keyId, fiatCode),
    (state: RootState) => state.RATE?.rates || {},
    (positions: Record<string, PortfolioPosition>, currentRates: any) =>
      buildAssetListFromPositions(currentRates as Rates, {fiatCode, positions}),
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectKeyAssetListByInterval = (
  keyId: string,
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
      (state: RootState) => state.RATE?.rates || {},
    ],
    (key: any, walletSyncs: any, tokens: TokensDataByAddress, currentRates: any) => {
      const wallets = (key as any)?.wallets || [];
      const syncedWalletIds: string[] = wallets
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));
      const events = neutralizeInternalTransfers(
        buildEventsForWalletTxs(tokens, {txs: allTxs}),
      );
      return buildAssetListWithIntervalPnlFromEvents(currentRates as Rates, {
        fiatCode,
        interval,
        events,
      });
    },
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectKeyChartSeries = (
  keyId: string,
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioChartSeries) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
    ],
    (key: any, walletSyncs: any, tokens: TokensDataByAddress) => {
      const wallets = (key as any)?.wallets || [];
      const syncedWalletIds: string[] = wallets
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));
      const rawEvents = buildEventsForWalletTxs(tokens, {txs: allTxs});
      const events = neutralizeInternalTransfers(rawEvents);
      return computeSeriesFromEvents({fiatCode, interval, events});
    },
  ) as ((state: RootState) => PortfolioChartSeries);

export const makeSelectPortfolioPositions = (
  fiatCode: string,
): ((state: RootState) => Record<string, PortfolioPosition>) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys,
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
    ],
    (keys: any, walletSyncs: any, tokens: TokensDataByAddress): Record<string, PortfolioPosition> => {
      const wallets: any[] = Object.values(keys as any).flatMap((k: any) => k.wallets);
      const syncedWalletIds: string[] = wallets
        .map(w => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));

      const rawEvents = buildEventsForWalletTxs(tokens, {txs: allTxs});
      const events = neutralizeInternalTransfers(rawEvents);
      return computePositionsFromEvents({fiatCode, events});
    },
  ) as ((state: RootState) => Record<string, PortfolioPosition>);

export const makeSelectPortfolioAssetList = (
  fiatCode: string,
): ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    makeSelectPortfolioPositions(fiatCode),
    (state: RootState) => state.RATE?.rates || {},
    (positions: Record<string, PortfolioPosition>, currentRates: any) =>
      buildAssetListFromPositions(currentRates as Rates, {fiatCode, positions}),
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectPortfolioAssetListByInterval = (
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioAssetList) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys,
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
      (state: RootState) => state.RATE?.rates || {},
    ],
    (keys: any, walletSyncs: any, tokens: TokensDataByAddress, currentRates: any) => {
      const wallets: any[] = Object.values(keys as any).flatMap((k: any) => k.wallets);
      const syncedWalletIds: string[] = wallets
        .map(w => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));
      const events = neutralizeInternalTransfers(
        buildEventsForWalletTxs(tokens, {txs: allTxs}),
      );
      return buildAssetListWithIntervalPnlFromEvents(currentRates as Rates, {
        fiatCode,
        interval,
        events,
      });
    },
  ) as ((state: RootState) => PortfolioAssetList);

export const makeSelectPortfolioChartSeries = (
  fiatCode: string,
  interval: PortfolioInterval,
) : ((state: RootState) => PortfolioChartSeries) =>
  createSelectorLoose(
    [
      (state: RootState) => state.WALLET.keys,
      (state: RootState) => state.PORTFOLIO.wallets,
      selectTokensDataByAddress,
    ],
    (keys: any, walletSyncs: any, tokens: TokensDataByAddress) => {
      const wallets: any[] = Object.values(keys as any).flatMap((k: any) => k.wallets);
      const syncedWalletIds: string[] = wallets
        .map(w => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));
      const rawEvents = buildEventsForWalletTxs(tokens, {txs: allTxs});
      const events = neutralizeInternalTransfers(rawEvents);
      return computeSeriesFromEvents({fiatCode, interval, events});
    },
  ) as ((state: RootState) => PortfolioChartSeries);
