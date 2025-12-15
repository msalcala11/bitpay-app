import {Effect} from '../index';
import {EntityRef, Timeframe, SeriesRefreshState, CostBasisMethod} from './portfolio.types';
import {buildSeriesKey} from './utils';
import {
  fetchFullHistory,
  buildCryptoTimeline,
  buildQuoteSeries,
  buildIncrementalQuoteSeries,
  mergeBalanceSeries,
  getTimeframeDurationMs,
  WalletSeriesWithMeta,
} from './services/history';
import {computeBreakeven, enrichTimelineWithRates} from './services/costBasis';
import {BalancePoint} from './portfolio.types';
import {upsertPortfolioSeries, upsertPortfolioStatus, upsertCryptoTimeline, upsertSeriesRefreshState, upsertBreakeven} from './portfolio.actions';
import {GetPrecision} from '../wallet/utils/currency';
import {Wallet} from '../wallet/wallet.models';
import {findWalletById} from '../wallet/utils/wallet';
import {getRateByCurrencyName} from '../../utils/helper-methods';
import {Rates} from '../rate/rate.models';

/**
 * Get the live fiat rate for a wallet from Redux rates.
 * Returns the rate per unit (e.g., USD per BTC).
 */
const getLiveRate = (
  wallet: Wallet,
  quoteCurrency: string,
  rates: Rates,
): number | undefined => {
  const ratesPerCurrency = getRateByCurrencyName(
    rates,
    wallet.currencyAbbreviation,
    wallet.chain,
    wallet.tokenAddress,
  );
  if (!ratesPerCurrency) {
    return undefined;
  }
  const rateObj = ratesPerCurrency.find(r => r.code === quoteCurrency);
  return rateObj?.rate;
};

const getWalletFromState = (walletId: string, keysState: any): Wallet | undefined => {
  const allWallets = Object.values(keysState).flatMap((key: any) => key.wallets || []);
  return findWalletById(allWallets, walletId) as Wallet | undefined;
};

export interface LoadBalanceSeriesParams {
  entity: EntityRef;
  timeframe: Timeframe;
  quoteCurrency?: string;
}

export const loadBalanceSeries = ({entity, timeframe, quoteCurrency}: LoadBalanceSeriesParams): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    const resolvedQuoteCurrency = quoteCurrency || state.PORTFOLIO.meta.quoteCurrency;
    const scopeKey = buildSeriesKey(entity, timeframe, resolvedQuoteCurrency);

    dispatch(
      upsertPortfolioStatus(scopeKey, {
        state: 'loading',
        error: null,
      }),
    );

    try {
      let points: BalancePoint[] = [];

      // Get live rates from Redux for final data point accuracy
      const rates = state.RATE.rates;

      if (entity.type === 'wallet' && entity.id) {
        // === WALLET SCOPE ===
        const wallet = getWalletFromState(entity.id, state.WALLET.keys);
        if (!wallet) {
          throw new Error('Wallet not found');
        }

        // Check for existing data for incremental refresh
        const existingSeries = state.PORTFOLIO.series[scopeKey];
        const existingRefreshState = state.PORTFOLIO.seriesRefreshState[scopeKey];
        const existingTimeline = state.PORTFOLIO.cryptoTimelines[scopeKey];

        // 1. Fetch full transaction history
        const transactions = await dispatch(fetchFullHistory({wallet}));

        // 2. Build crypto-only timeline (pure, no fiat)
        const cryptoTimeline = buildCryptoTimeline(transactions);

        // 3. Get live rate for final data point
        const liveRate = getLiveRate(wallet, resolvedQuoteCurrency, rates);

        // 4. Check if we can do incremental refresh
        const canDoIncremental = 
          existingSeries?.length > 0 &&
          existingRefreshState &&
          existingTimeline?.length > 0 &&
          // Only incremental if no new transactions (same tx count)
          // or if we have the same timeline structure
          cryptoTimeline.length >= existingRefreshState.lastTxCount;

        if (canDoIncremental) {
          // Incremental refresh: left-shift and append new data
          const {points: updatedPoints, refreshState: newRefreshState} = await dispatch(
            buildIncrementalQuoteSeries({
              wallet,
              existingSeries,
              existingRefreshState,
              cryptoTimeline,
              quoteCurrency: resolvedQuoteCurrency,
              timeframe,
              liveRate,
            }),
          );
          points = updatedPoints;
          dispatch(upsertSeriesRefreshState(scopeKey, newRefreshState));
          
          // Always enrich timeline in dev mode during incremental refresh
          // (rates may have been missing from previous loads)
          if (__DEV__) {
            const precision = dispatch(
              GetPrecision(wallet.currencyAbbreviation, wallet.chain, wallet.tokenAddress),
            );
            const unitToSatoshi = precision?.unitToSatoshi || 1e8;
            const costBasisMethod: CostBasisMethod = 'AVG';
            const enrichedTimeline = await enrichTimelineWithRates({
              timeline: cryptoTimeline,
              quoteCurrency: resolvedQuoteCurrency,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
              tokenAddress: wallet.tokenAddress,
              unitToSatoshi,
              method: costBasisMethod,
            });
            dispatch(upsertCryptoTimeline(scopeKey, enrichedTimeline));
          }
        } else {
          // Full rebuild
          points = await dispatch(
            buildQuoteSeries({
              wallet,
              cryptoTimeline,
              quoteCurrency: resolvedQuoteCurrency,
              timeframe,
              liveRate,
            }),
          );

          // Store metadata for future incremental refreshes
          const now = Date.now();
          const timeframeDuration = getTimeframeDurationMs(timeframe);
          const windowStart = timeframeDuration
            ? now - timeframeDuration
            : cryptoTimeline[0]?.timestamp || now;
          
          const newRefreshState: SeriesRefreshState = {
            lastUpdated: now,
            lastCryptoAmount: cryptoTimeline[cryptoTimeline.length - 1]?.amount || 0,
            lastTxCount: cryptoTimeline.length,
            windowStart,
          };
          dispatch(upsertSeriesRefreshState(scopeKey, newRefreshState));
        }

        // 5. Compute breakeven / cost basis (uses same transactions, reuses rate cache)
        const precision = dispatch(
          GetPrecision(
            wallet.currencyAbbreviation,
            wallet.chain,
            wallet.tokenAddress,
          ),
        );
        const unitToSatoshi = precision?.unitToSatoshi || 1e8;
        const costBasisMethod: CostBasisMethod = 'AVG'; // TODO: read from settings
        
        const breakevenResult = await computeBreakeven({
          transactions,
          method: costBasisMethod,
          quoteCurrency: resolvedQuoteCurrency,
          currencyAbbreviation: wallet.currencyAbbreviation,
          chain: wallet.chain,
          tokenAddress: wallet.tokenAddress,
          unitToSatoshi,
        });
        
        // Use wallet-level scope key for breakeven (not timeframe-specific)
        const breakevenScopeKey = `wallet:${entity.id}:${resolvedQuoteCurrency}`;
        dispatch(upsertBreakeven(breakevenScopeKey, breakevenResult));

        // 6. Enrich crypto timeline with fiat rates and running breakeven (debug only)
        if (__DEV__) {
          const enrichedTimeline = await enrichTimelineWithRates({
            timeline: cryptoTimeline,
            quoteCurrency: resolvedQuoteCurrency,
            currencyAbbreviation: wallet.currencyAbbreviation,
            chain: wallet.chain,
            tokenAddress: wallet.tokenAddress,
            unitToSatoshi,
            method: costBasisMethod,
          });
          dispatch(upsertCryptoTimeline(scopeKey, enrichedTimeline));
        } else {
          dispatch(upsertCryptoTimeline(scopeKey, cryptoTimeline));
        }
      } else if (entity.type === 'key' && entity.id) {
        // === KEY SCOPE ===
        const key = state.WALLET.keys[entity.id];
        if (!key) {
          throw new Error('Key not found');
        }

        // Skip keys that haven't been backed up yet
        if (!key.backupComplete) {
          throw new Error('Key needs backup before viewing balance history');
        }

        // Filter out testnet wallets
        const wallets = (key.wallets || []).filter(
          (w: Wallet) => w.network === 'livenet',
        );
        if (wallets.length === 0) {
          throw new Error('Key has no mainnet wallets');
        }

        // 1. Load series for each wallet, reusing cached data when available
        const walletSeriesWithMeta: WalletSeriesWithMeta[] = [];
        const CACHE_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes
        const now = Date.now();

        for (const wallet of wallets) {
          // Check for cached wallet-level series
          const walletScopeKey = buildSeriesKey(
            {type: 'wallet', id: wallet.id},
            timeframe,
            resolvedQuoteCurrency,
          );
          const cachedSeries = state.PORTFOLIO.series[walletScopeKey];
          const cachedRefreshState = state.PORTFOLIO.seriesRefreshState[walletScopeKey];
          
          // Reuse cached data if fresh enough
          const isCacheFresh = cachedRefreshState?.lastUpdated && 
            (now - cachedRefreshState.lastUpdated) < CACHE_FRESHNESS_MS;
          
          if (cachedSeries?.length > 0 && isCacheFresh) {
            // Reuse cached wallet series
            walletSeriesWithMeta.push({
              series: cachedSeries,
              walletId: wallet.id,
              walletName: wallet.walletName,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
            });
          } else {
            // Compute fresh data for this wallet
            const transactions = await dispatch(fetchFullHistory({wallet}));
            const cryptoTimeline = buildCryptoTimeline(transactions);
            const liveRate = getLiveRate(wallet, resolvedQuoteCurrency, rates);
            const series = await dispatch(
              buildQuoteSeries({
                wallet,
                cryptoTimeline,
                quoteCurrency: resolvedQuoteCurrency,
                timeframe,
                liveRate,
              }),
            );
            
            // Cache the wallet-level series for future reuse
            dispatch(upsertPortfolioSeries(walletScopeKey, series));
            const timeframeDuration = getTimeframeDurationMs(timeframe);
            dispatch(upsertSeriesRefreshState(walletScopeKey, {
              lastUpdated: now,
              lastCryptoAmount: cryptoTimeline[cryptoTimeline.length - 1]?.amount || 0,
              lastTxCount: cryptoTimeline.length,
              windowStart: timeframeDuration ? now - timeframeDuration : now,
            }));
            
            walletSeriesWithMeta.push({
              series,
              walletId: wallet.id,
              walletName: wallet.walletName,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
            });
          }
        }

        // 2. Merge wallet series into key series (with breakdown)
        points = mergeBalanceSeries(walletSeriesWithMeta, resolvedQuoteCurrency);
      } else if (entity.type === 'account' && entity.accountAddress && entity.accountKeyId) {
        // === ACCOUNT SCOPE (EVM/SVM wallets sharing same address) ===
        const key = state.WALLET.keys[entity.accountKeyId];
        if (!key) {
          throw new Error('Key not found for account');
        }

        // Skip keys that haven't been backed up yet
        if (!key.backupComplete) {
          throw new Error('Key needs backup before viewing balance history');
        }

        // Filter wallets by receive address and livenet
        const wallets = (key.wallets || []).filter(
          (w: Wallet) => w.receiveAddress === entity.accountAddress && w.network === 'livenet',
        );
        if (wallets.length === 0) {
          throw new Error('Account has no mainnet wallets');
        }

        // 1. Load series for each wallet, reusing cached data when available
        const walletSeriesWithMeta: WalletSeriesWithMeta[] = [];
        const CACHE_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes
        const now = Date.now();

        for (const wallet of wallets) {
          // Check for cached wallet-level series
          const walletScopeKey = buildSeriesKey(
            {type: 'wallet', id: wallet.id},
            timeframe,
            resolvedQuoteCurrency,
          );
          const cachedSeries = state.PORTFOLIO.series[walletScopeKey];
          const cachedRefreshState = state.PORTFOLIO.seriesRefreshState[walletScopeKey];
          
          // Reuse cached data if fresh enough
          const isCacheFresh = cachedRefreshState?.lastUpdated && 
            (now - cachedRefreshState.lastUpdated) < CACHE_FRESHNESS_MS;
          
          if (cachedSeries?.length > 0 && isCacheFresh) {
            // Reuse cached wallet series
            walletSeriesWithMeta.push({
              series: cachedSeries,
              walletId: wallet.id,
              walletName: wallet.walletName,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
            });
          } else {
            // Compute fresh data for this wallet
            const transactions = await dispatch(fetchFullHistory({wallet}));
            const cryptoTimeline = buildCryptoTimeline(transactions);
            const liveRate = getLiveRate(wallet, resolvedQuoteCurrency, rates);
            const series = await dispatch(
              buildQuoteSeries({
                wallet,
                cryptoTimeline,
                quoteCurrency: resolvedQuoteCurrency,
                timeframe,
                liveRate,
              }),
            );
            
            // Cache the wallet-level series for future reuse
            dispatch(upsertPortfolioSeries(walletScopeKey, series));
            const timeframeDuration = getTimeframeDurationMs(timeframe);
            dispatch(upsertSeriesRefreshState(walletScopeKey, {
              lastUpdated: now,
              lastCryptoAmount: cryptoTimeline[cryptoTimeline.length - 1]?.amount || 0,
              lastTxCount: cryptoTimeline.length,
              windowStart: timeframeDuration ? now - timeframeDuration : now,
            }));
            
            walletSeriesWithMeta.push({
              series,
              walletId: wallet.id,
              walletName: wallet.walletName,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
            });
          }
        }

        // 2. Merge wallet series into account series (with breakdown)
        points = mergeBalanceSeries(walletSeriesWithMeta, resolvedQuoteCurrency);
      } else if (entity.type === 'portfolio') {
        // === PORTFOLIO SCOPE ===
        // Filter out testnet wallets and wallets from keys that need backup
        const allWallets = Object.values(state.WALLET.keys)
          .filter((key: any) => key.backupComplete) // Skip keys that need backup
          .flatMap((key: any) => key.wallets || [])
          .filter((w: Wallet) => w.network === 'livenet');

        if (allWallets.length === 0) {
          throw new Error('No mainnet wallets found (keys may need backup)');
        }

        // 1. Load series for each wallet, reusing cached data when available
        const walletSeriesWithMeta: WalletSeriesWithMeta[] = [];
        const CACHE_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes
        const now = Date.now();

        for (const wallet of allWallets) {
          // Check for cached wallet-level series
          const walletScopeKey = buildSeriesKey(
            {type: 'wallet', id: wallet.id},
            timeframe,
            resolvedQuoteCurrency,
          );
          const cachedSeries = state.PORTFOLIO.series[walletScopeKey];
          const cachedRefreshState = state.PORTFOLIO.seriesRefreshState[walletScopeKey];
          
          // Reuse cached data if fresh enough
          const isCacheFresh = cachedRefreshState?.lastUpdated && 
            (now - cachedRefreshState.lastUpdated) < CACHE_FRESHNESS_MS;
          
          if (cachedSeries?.length > 0 && isCacheFresh) {
            // Reuse cached wallet series
            walletSeriesWithMeta.push({
              series: cachedSeries,
              walletId: wallet.id,
              walletName: wallet.walletName,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
            });
          } else {
            // Compute fresh data for this wallet
            const transactions = await dispatch(fetchFullHistory({wallet}));
            const cryptoTimeline = buildCryptoTimeline(transactions);
            const liveRate = getLiveRate(wallet, resolvedQuoteCurrency, rates);
            const series = await dispatch(
              buildQuoteSeries({
                wallet,
                cryptoTimeline,
                quoteCurrency: resolvedQuoteCurrency,
                timeframe,
                liveRate,
              }),
            );
            
            // Cache the wallet-level series for future reuse
            dispatch(upsertPortfolioSeries(walletScopeKey, series));
            const timeframeDuration = getTimeframeDurationMs(timeframe);
            dispatch(upsertSeriesRefreshState(walletScopeKey, {
              lastUpdated: now,
              lastCryptoAmount: cryptoTimeline[cryptoTimeline.length - 1]?.amount || 0,
              lastTxCount: cryptoTimeline.length,
              windowStart: timeframeDuration ? now - timeframeDuration : now,
            }));
            
            walletSeriesWithMeta.push({
              series,
              walletId: wallet.id,
              walletName: wallet.walletName,
              currencyAbbreviation: wallet.currencyAbbreviation,
              chain: wallet.chain,
            });
          }
        }

        // 2. Merge all wallet series into portfolio series (with breakdown)
        points = mergeBalanceSeries(walletSeriesWithMeta, resolvedQuoteCurrency);
      } else {
        throw new Error('Invalid entity type or missing entity id');
      }

      dispatch(upsertPortfolioSeries(scopeKey, points));
      dispatch(
        upsertPortfolioStatus(scopeKey, {
          state: 'succeeded',
          lastUpdated: Date.now(),
          error: null,
        }),
      );
    } catch (err) {
      dispatch(
        upsertPortfolioStatus(scopeKey, {
          state: 'failed',
          error: err instanceof Error ? err.message : 'Unknown error',
        }),
      );
    }
  };
