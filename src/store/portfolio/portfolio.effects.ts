import moment from 'moment';
import {Effect} from '..';
import {Wallet} from '../wallet/wallet.models';
import {
  BWS_TX_HISTORY_LIMIT,
  GetTransactionHistoryFromServer,
} from '../wallet/effects/transactions/transactions';
import {getHistoricFiatRate} from '../wallet/effects/rates/rates';
import {setPortfolioGlobalSync, updatePortfolioWalletSync} from './portfolio.actions';
import {
  appendWalletTxs,
  PortfolioTx,
  resetWalletTxs,
  readWalletTxs,
  upsertRateMap,
  readRateMap,
  readWalletTxMeta,
} from './portfolio.storage';
import {BitpaySupportedTokenOptsByAddress} from '../../constants/tokens';
import {tokenManager} from '../../managers/TokenManager';
import {IsSVMChain} from '../wallet/utils/currency';

const normalizeTxs = (wallet: Wallet, txs: any[]): PortfolioTx[] => {
  return txs
    .filter(t => t && (t.txid || t.id))
    .map(t => {
      const timeMs =
        typeof t.time === 'number'
          ? t.time * 1000
          : typeof t.createdOn === 'number'
          ? t.createdOn * 1000
          : Date.now();
      return {
        txid: t.txid || t.id,
        time: timeMs,
        action: t.action,
        amount: typeof t.amount === 'number' ? t.amount : undefined,
        fees: typeof t.fees === 'number' ? t.fees : undefined,
        fee: typeof t.fee === 'number' ? t.fee : undefined,
        coin: t.coin || wallet.currencyAbbreviation,
        chain: t.chain || wallet.chain,
        tokenAddress: t.tokenAddress || wallet.tokenAddress,
        effects: t.effects,
      };
    });
};

const getRateSymbolForWalletTxs = (
  wallet: Wallet,
  txs: PortfolioTx[],
  customTokenOptionsByAddress: Record<string, any>,
): string => {
  const {tokenOptionsByAddress} = tokenManager.getTokenOptions();
  const tokensOptsByAddress = {
    ...BitpaySupportedTokenOptsByAddress,
    ...tokenOptionsByAddress,
    ...customTokenOptionsByAddress,
  };

  const firstTxWithContract = txs.find(t =>
    IsSVMChain(wallet.chain)
      ? t.tokenAddress
      : typeof t.tokenAddress === 'string' && t.tokenAddress.length > 0,
  );

  const contractAddress = firstTxWithContract?.tokenAddress;

  if (contractAddress) {
    const matchedToken = Object.values(tokensOptsByAddress).find(({address}) => {
      if (IsSVMChain(wallet.chain)) {
        return contractAddress === address;
      }
      return contractAddress.toLowerCase() === address?.toLowerCase();
    });
    if (matchedToken?.symbol) {
      return matchedToken.symbol.toLowerCase();
    }
  }

  switch (wallet.currencyAbbreviation?.toLowerCase()) {
    case 'wbtc':
      return 'btc';
    case 'weth':
      return 'eth';
    default:
      return wallet.currencyAbbreviation?.toLowerCase();
  }
};

export const portfolioBackfillAllWalletTxs =
  ({
    fiatCode,
    force,
  }: {
    fiatCode: string;
    force?: boolean;
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const {
      WALLET: {keys},
    } = getState();

    const wallets: Wallet[] = Object.values(keys as any)
      .flatMap((k: any) => k.wallets)
      .filter(w => typeof w?.id === 'string' && w.isComplete());

    dispatch(
      setPortfolioGlobalSync({
        status: 'syncing',
        startedOn: Date.now(),
        finishedOn: undefined,
        walletsTotal: wallets.length,
        walletsDone: 0,
        currentWalletId: undefined,
        error: undefined,
      }),
    );

    let walletsDone = 0;

    for (const wallet of wallets) {
      try {
        dispatch(
          setPortfolioGlobalSync({
            currentWalletId: wallet.id,
          }),
        );

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            status: 'syncing',
            startedOn: Date.now(),
            finishedOn: undefined,
            error: undefined,
            txCount: 0,
            chunkCount: 0,
          }),
        );

        const existing = force ? [] : readWalletTxs(wallet.id);
        const existingMeta = force
          ? {txCount: 0, chunkCount: 0}
          : readWalletTxMeta(wallet.id);
        const existingSync = getState().PORTFOLIO?.wallets?.[wallet.id];

        if (force) {
          resetWalletTxs(wallet.id);
        } else if (existing.length > 0 && existingSync?.status === 'done') {
          dispatch(
            updatePortfolioWalletSync({
              keyId: wallet.keyId,
              walletId: wallet.id,
              status: 'done',
              finishedOn: Date.now(),
              txCount: existingMeta.txCount,
              chunkCount: existingMeta.chunkCount,
            }),
          );
          walletsDone++;
          dispatch(setPortfolioGlobalSync({walletsDone}));
          continue;
        }

        // Resume if we have partial data; otherwise start fresh.
        if (!force && existing.length === 0) {
          resetWalletTxs(wallet.id);
        }

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            txCount: existingMeta.txCount,
            chunkCount: existingMeta.chunkCount,
          }),
        );

        let skip = existingMeta.txCount;
        let totalSaved = 0;
        while (true) {
          const {transactions, loadMore} = await GetTransactionHistoryFromServer(
            wallet,
            skip,
            null,
            BWS_TX_HISTORY_LIMIT,
          );

          if (!transactions?.length) {
            break;
          }

          const normalized = normalizeTxs(wallet, transactions);
          const meta = appendWalletTxs(wallet.id, normalized);
          totalSaved = meta.txCount;

          dispatch(
            updatePortfolioWalletSync({
              keyId: wallet.keyId,
              walletId: wallet.id,
              txCount: totalSaved,
              chunkCount: meta.chunkCount,
            }),
          );

          skip += transactions.length;
          if (!loadMore) {
            break;
          }
        }

        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            status: 'done',
            finishedOn: Date.now(),
          }),
        );

        walletsDone++;
        dispatch(setPortfolioGlobalSync({walletsDone}));
      } catch (e: any) {
        const err = e instanceof Error ? e.message : JSON.stringify(e);
        dispatch(
          updatePortfolioWalletSync({
            keyId: wallet.keyId,
            walletId: wallet.id,
            status: 'error',
            finishedOn: Date.now(),
            error: err,
          }),
        );
      }
    }

    dispatch(
      setPortfolioGlobalSync({
        status: 'done',
        finishedOn: Date.now(),
        currentWalletId: undefined,
      }),
    );

    await dispatch(portfolioBackfillHistoricRates({fiatCode}));
  };

export const portfolioBackfillHistoricRates =
  ({
    fiatCode,
  }: {
    fiatCode: string;
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const {
      WALLET: {keys, customTokenOptionsByAddress},
    } = getState();

    const wallets: Wallet[] = Object.values(keys as any)
      .flatMap((k: any) => k.wallets)
      .filter(w => typeof w?.id === 'string' && w.isComplete());

    for (const wallet of wallets) {
      const walletSync = getState().PORTFOLIO?.wallets?.[wallet.id];
      if (walletSync?.status !== 'done') {
        continue;
      }

      const txs = readWalletTxs(wallet.id);
      if (!txs.length) {
        continue;
      }

      const symbol = getRateSymbolForWalletTxs(
        wallet,
        txs,
        customTokenOptionsByAddress,
      );

      const rateMap = readRateMap(fiatCode, symbol);
      const neededDays = new Set<string>();

      txs.forEach(tx => {
        const dayTs = moment(tx.time).startOf('day').valueOf();
        const key = String(dayTs);
        if (rateMap[key] == null) {
          neededDays.add(key);
        }
      });

      for (const dayKey of neededDays) {
        try {
          const historic = await getHistoricFiatRate(
            fiatCode,
            symbol,
            dayKey,
          );
          if (historic?.rate != null) {
            upsertRateMap(fiatCode, symbol, {[dayKey]: historic.rate});
          }
        } catch (_) {}
      }
    }
  };
