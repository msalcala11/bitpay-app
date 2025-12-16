import moment from 'moment';
import {createSelector} from 'reselect';
import {AppSelector, RootState} from '..';
import {
  PortfolioTx,
  readRateMap,
  readWalletTxs,
} from './portfolio.storage';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../constants/currencies';
import {tokenManager} from '../../managers/TokenManager';
import {getCurrencyAbbreviation} from '../../utils/helper-methods';

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

const getUnitInfo = (
  state: RootState,
  {
    chain,
    tokenAddress,
  }: {
    chain: string;
    tokenAddress?: string;
  },
): UnitInfo | undefined => {
  const tokens = buildTokensDataByAddress(state);

  if (tokenAddress) {
    const currencyName = getCurrencyAbbreviation(tokenAddress, chain);
    return tokens[currencyName]?.unitInfo;
  }

  return BitpaySupportedCoins[chain]?.unitInfo as UnitInfo | undefined;
};

const getRateSymbol = (
  state: RootState,
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
    const tokens = buildTokensDataByAddress(state);
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
  state: RootState,
  {
    fiatCode,
    txs,
  }: {
    fiatCode: string;
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

    const unitInfo = getUnitInfo(state, {chain, tokenAddress});
    if (!unitInfo?.unitToSatoshi) {
      continue;
    }

    const rateSymbol = getRateSymbol(state, {chain, coin, tokenAddress});
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
      } else if (action === 'sent' || action === 'moved') {
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
      const feeUnitInfo = getUnitInfo(state, {chain, tokenAddress: undefined});
      if (feeUnitInfo?.unitToSatoshi) {
        const feeUnits = satToUnit(feeSat, feeUnitInfo.unitToSatoshi);
        if (feeUnits) {
          const feeAssetKey = getAssetKey({
            chain,
            coin: feeCurrency,
            tokenAddress: undefined,
          });
          const feeRateSymbol = getRateSymbol(state, {
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
  state: RootState,
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
  for (const s of symbols) {
    rateMaps[s] = readRateMap(fiatCode, s);
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
      const dayKey = String(moment(e.time).startOf('day').valueOf());
      rate = rateMaps[e.rateSymbol]?.[dayKey];
    }

    applyDeltaUnits(pos, e.deltaUnits, rate);
  }

  return positions;
};

export const selectPortfolioGlobalSync: AppSelector = ({PORTFOLIO}) =>
  PORTFOLIO.global;

export const selectPortfolioWalletsSync: AppSelector = ({PORTFOLIO}) =>
  PORTFOLIO.wallets;

export const makeSelectWalletPositions = (
  walletId: string,
  fiatCode: string,
) =>
  createSelector(
    [
      (state: RootState) => state.PORTFOLIO.wallets[walletId]?.txCount || 0,
      (state: RootState) => state,
    ],
    (_txCount, state) => {
      const txs = readWalletTxs(walletId);
      const events = buildEventsForWalletTxs(state, {fiatCode, txs});
      return computePositionsFromEvents(state, {fiatCode, events});
    },
  );

export const makeSelectKeyPositions = (keyId: string, fiatCode: string) =>
  createSelector(
    [
      (state: RootState) => state.WALLET.keys[keyId],
      (state: RootState) => state.PORTFOLIO.wallets,
      (state: RootState) => state,
    ],
    (key, walletSyncs, state) => {
      const wallets = (key as any)?.wallets || [];
      const syncedWalletIds: string[] = wallets
        .map((w: any) => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));

      const rawEvents = buildEventsForWalletTxs(state, {fiatCode, txs: allTxs});
      const events = neutralizeInternalTransfers(rawEvents);
      return computePositionsFromEvents(state, {fiatCode, events});
    },
  );

export const makeSelectPortfolioPositions = (fiatCode: string) =>
  createSelector(
    [
      (state: RootState) => state.WALLET.keys,
      (state: RootState) => state.PORTFOLIO.wallets,
      (state: RootState) => state,
    ],
    (keys, walletSyncs, state) => {
      const wallets: any[] = Object.values(keys as any).flatMap((k: any) => k.wallets);
      const syncedWalletIds: string[] = wallets
        .map(w => w?.id)
        .filter((id: any) => typeof id === 'string')
        .filter((id: string) => walletSyncs[id]?.status === 'done');

      const allTxs = syncedWalletIds.flatMap(id => readWalletTxs(id));

      const rawEvents = buildEventsForWalletTxs(state, {fiatCode, txs: allTxs});
      const events = neutralizeInternalTransfers(rawEvents);
      return computePositionsFromEvents(state, {fiatCode, events});
    },
  );
