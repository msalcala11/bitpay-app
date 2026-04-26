import {DeviceEventEmitter} from 'react-native';

import {DeviceEmitterEvents} from '../../constants/device-emitter-events';
import type {Effect, RootState} from '..';
import {pruneFiatRateSeriesCache} from '../rate/rate.actions';
import {fetchFiatRateSeriesAllIntervals, startGetRates} from '../wallet/effects';
import {
  setSnapshotBalanceMismatchesByWalletIdUpdates,
  startPopulatePortfolio,
} from './portfolio.actions';
import {
  getLatestSnapshot,
  getWalletIdsToPopulateFromSnapshots,
  getVisibleWalletsFromKeys,
} from '../../utils/portfolio/assets';

const resolveQuoteCurrency = (
  argsQuoteCurrency: string | undefined,
  state: RootState,
): string => {
  return String(
    argsQuoteCurrency || state.APP?.defaultAltCurrency?.isoCode || 'USD',
  ).toUpperCase();
};

const isPortfolioUnavailable = (state: RootState): boolean => {
  return (
    state.APP?.showPortfolioValue === false ||
    state.PORTFOLIO?.populateDisabled === true ||
    state.PORTFOLIO?.populateStatus?.inProgress === true
  );
};

const isAppLocked = (state: RootState): boolean => {
  return (
    !!(state.APP?.pinLockActive || state.APP?.biometricLockActive) &&
    !Number.isFinite(Number(state.APP?.lockAuthorizedUntil))
  );
};

const deferUntilUnlock = (): void => {
  DeviceEventEmitter.addListener(
    DeviceEmitterEvents.APP_LOCK_MODAL_DISMISSED,
    () => undefined,
  );
};

const hasNonZeroBalance = (wallet: any): boolean => {
  const sat = Number(wallet?.balance?.sat || 0);
  const crypto = Number(wallet?.balance?.crypto || 0);
  return sat > 0 || crypto > 0;
};

const isMainnetWallet = (wallet: any): boolean => {
  const network = String(wallet?.network || '').toLowerCase();
  return network === 'livenet' || network === 'mainnet' || network === '';
};

export const maybePopulatePortfolioForWallets =
  (args: {wallets: any[]; quoteCurrency?: string}): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    if (isPortfolioUnavailable(state)) {
      return;
    }
    if (isAppLocked(state)) {
      deferUntilUnlock();
      return;
    }

    const wallets = Array.isArray(args.wallets) ? args.wallets : [];
    if (!wallets.length) {
      return;
    }

    const decisions = getWalletIdsToPopulateFromSnapshots({
      wallets: wallets as any,
      snapshotsByWalletId: state.PORTFOLIO?.snapshotsByWalletId,
      previousSnapshotBalanceMismatchesByWalletId:
        state.PORTFOLIO?.snapshotBalanceMismatchesByWalletId,
    });
    if (Object.keys(decisions.snapshotBalanceMismatchUpdates || {}).length) {
      dispatch(
        setSnapshotBalanceMismatchesByWalletIdUpdates(
          decisions.snapshotBalanceMismatchUpdates,
        ),
      );
    }
    if (!decisions.walletIdsToPopulate.length) {
      return;
    }

    await dispatch(
      populatePortfolio({
        walletIds: decisions.walletIdsToPopulate,
        quoteCurrency: args.quoteCurrency,
      }) as any,
    );
  };

export const populatePortfolio =
  (args?: {
    wallets?: any[];
    walletIds?: string[];
    quoteCurrency?: string;
  }): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    if (isPortfolioUnavailable(state)) {
      return;
    }
    if (isAppLocked(state)) {
      deferUntilUnlock();
      return;
    }

    const quoteCurrency = resolveQuoteCurrency(args?.quoteCurrency, state);
    const walletIdFilter = new Set(args?.walletIds || []);
    const visibleWallets =
      args?.wallets ||
      getVisibleWalletsFromKeys(
        state.WALLET?.keys,
        state.APP?.homeCarouselConfig,
      );
    const walletsToPopulate = (visibleWallets || [])
      .filter(wallet => (walletIdFilter.size ? walletIdFilter.has(wallet.id) : true))
      .filter(wallet => isMainnetWallet(wallet) && hasNonZeroBalance(wallet));

    if (!walletsToPopulate.length) {
      return;
    }

    dispatch(startPopulatePortfolio({quoteCurrency}));
    await dispatch(startGetRates({force: true}) as any);
  };

export const preparePortfolioFiatRateCachesForQuoteCurrencySwitch =
  (args?: {quoteCurrency?: string}): Effect<Promise<void>> =>
  async (dispatch, getState) => {
    const state = getState();
    if (
      state.APP?.showPortfolioValue === false ||
      state.PORTFOLIO?.populateDisabled === true ||
      state.PORTFOLIO?.populateStatus?.inProgress
    ) {
      return;
    }

    const quoteCurrency = resolveQuoteCurrency(args?.quoteCurrency, state);
    const allowedFiats = new Set<string>([quoteCurrency]);

    await dispatch(
      fetchFiatRateSeriesAllIntervals({
        fiatCode: quoteCurrency,
        currencyAbbreviation: 'btc',
      }) as any,
    );

    const visibleWallets = getVisibleWalletsFromKeys(
      state.WALLET?.keys,
      state.APP?.homeCarouselConfig,
    );
    const snapshotsByWalletId = state.PORTFOLIO?.snapshotsByWalletId || {};

    for (const wallet of visibleWallets || []) {
      const latestSnapshot = getLatestSnapshot(snapshotsByWalletId[wallet.id]);
      const sourceQuoteCurrency = String(
        latestSnapshot?.quoteCurrency || '',
      ).toUpperCase();
      if (!sourceQuoteCurrency || sourceQuoteCurrency === quoteCurrency) {
        continue;
      }

      allowedFiats.add(sourceQuoteCurrency);
      await dispatch(
        fetchFiatRateSeriesAllIntervals({
          fiatCode: sourceQuoteCurrency,
          allowedCoins: ['btc'],
        }) as any,
      );
    }

    const fiatRateSeriesCache = (state.RATE as any)?.fiatRateSeriesCache || {};
    for (const cacheKey of Object.keys(fiatRateSeriesCache)) {
      const fiatCode = String(cacheKey.split(':')[0] || '').toUpperCase();
      if (fiatCode && !allowedFiats.has(fiatCode)) {
        dispatch(pruneFiatRateSeriesCache({fiatCode}) as any);
      }
    }
  };
