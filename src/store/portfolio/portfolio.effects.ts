import {Effect} from '..';
import {logManager} from '../../managers/LogManager';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistory,
} from '../wallet/effects/transactions/transactions';
import {GetPrecision} from '../wallet/utils/currency';
import {Wallet} from '../wallet/wallet.models';
import {
  PortfolioTxEvent,
  PortfolioTxEventCategory,
  PortfolioInterval,
} from './portfolio.types';
import {setTxEventsForWallet, setWalletIntervalCursor} from './portfolio.actions';
import {buildWalletIntervalCursor} from './portfolio.cursor';

const getAssetIdFromWallet = (wallet: Wallet): string => {
  const coin = wallet.currencyAbbreviation?.toLowerCase() || '';
  const chain = wallet.chain?.toLowerCase() || '';
  const tokenAddress = wallet.tokenAddress?.toLowerCase();
  return tokenAddress ? `${chain}:${coin}:${tokenAddress}` : `${chain}:${coin}`;
};

const mapActionToCategory = (action: string | undefined): {
  category: PortfolioTxEventCategory;
  cryptoDeltaSign: 1 | -1 | 0;
} | null => {
  switch (action) {
    case 'received':
      return {category: 'receive', cryptoDeltaSign: 1};
    case 'sent':
      return {category: 'spend', cryptoDeltaSign: -1};
    case 'moved':
      return {category: 'moved', cryptoDeltaSign: 0};
    default:
      return null;
  }
};

const getTxFeeBaseUnits = (tx: any): number | undefined => {
  const gasUsed = tx?.receipt?.gasUsed;
  const effectiveGasPrice = tx?.receipt?.effectiveGasPrice;
  if (gasUsed != null && effectiveGasPrice != null) {
    const fee = Number(gasUsed) * Number(effectiveGasPrice);
    if (Number.isFinite(fee)) {
      return fee;
    }
  }

  const fee = tx?.fees ?? tx?.fee;
  if (fee == null) {
    return undefined;
  }
  const n = Number(fee);
  return Number.isFinite(n) ? n : undefined;
};

export const fetchFullTransactionHistoryForWallet = (
  wallet: Wallet,
): Effect<Promise<{transactions: any[]; requestCount: number}>> => async dispatch => {
  let acc: any[] = [];
  let loadMore = true;
  let iters = 0;
  let requestCount = 0;

  while (loadMore) {
    requestCount++;
    const {transactions, loadMore: _loadMore} = await dispatch(
      GetTransactionHistory({
        wallet,
        transactionsHistory: acc,
        limit: BWS_TX_HISTORY_LIMIT,
        refresh: iters === 0,
        isExportHistoryView: false,
      }),
    );
    acc = transactions;
    loadMore = _loadMore;
    iters++;
  }

  return {transactions: acc, requestCount};
};

export const normalizeTxHistoryToPortfolioTxEvents = (
  wallet: Wallet,
  transactions: any[],
): Effect<PortfolioTxEvent[]> =>
  (dispatch: any) => {
    const precision = dispatch(
      GetPrecision(wallet.currencyAbbreviation, wallet.chain, wallet.tokenAddress),
    ) as any;

    const unitToSatoshi = Number(precision?.unitToSatoshi) || 1;
    const assetId = getAssetIdFromWallet(wallet);

    const events: PortfolioTxEvent[] = [];

    for (const tx of transactions) {
      const actionMapping = mapActionToCategory(tx?.action);
      if (!actionMapping) {
        continue;
      }

      const time = Number(tx?.time);
      if (!Number.isFinite(time)) {
        continue;
      }

      const txid = String(tx?.txid || '');
      if (!txid) {
        continue;
      }

      const amountBaseUnits = Number(tx?.amount) || 0;
      const amountCrypto = amountBaseUnits / unitToSatoshi;

      const feeBaseUnits = getTxFeeBaseUnits(tx);
      const feeCrypto = feeBaseUnits != null ? feeBaseUnits / unitToSatoshi : undefined;

      const cryptoDelta = actionMapping.cryptoDeltaSign * amountCrypto;

      events.push({
        walletId: wallet.id,
        txid,
        time,
        assetId,
        category: actionMapping.category,
        cryptoDelta,
        feeCrypto,
        confirmed: Number(tx?.confirmations || 0) > 0,
        status: tx?.status,
      });
    }

    return events.sort((a, b) => a.time - b.time);
  };

export const syncPortfolioTxEventsForWallet = (
  wallet: Wallet,
): Effect<Promise<{events: PortfolioTxEvent[]; requestCount: number}>> => async dispatch => {
  try {
    const {transactions, requestCount} = await dispatch(
      fetchFullTransactionHistoryForWallet(wallet),
    );
    const events = dispatch(normalizeTxHistoryToPortfolioTxEvents(wallet, transactions));
    dispatch(
      setTxEventsForWallet({
        walletId: wallet.id,
        txEvents: events,
      }),
    );
    return {events, requestCount};
  } catch (e) {
    const err = e instanceof Error ? e.message : JSON.stringify(e);
    logManager.error('[portfolio] syncPortfolioTxEventsForWallet error:', err);
    return {events: [], requestCount: 0};
  }
};

export const buildCursorForWalletInterval = (
  walletId: string,
  interval: PortfolioInterval,
): Effect<Promise<void>> => async (dispatch, getState) => {
  try {
    const state = getState();
    const events = state.PORTFOLIO.txEventsByWalletId[walletId] || [];
    const cursor = buildWalletIntervalCursor(walletId, interval, events);
    dispatch(
      setWalletIntervalCursor({
        walletId,
        interval,
        cursor,
      }),
    );
  } catch (e) {
    const err = e instanceof Error ? e.message : JSON.stringify(e);
    logManager.error(
      `[portfolio] buildCursorForWalletInterval error for wallet ${walletId} interval ${interval}:`,
      err,
    );
  }
};
