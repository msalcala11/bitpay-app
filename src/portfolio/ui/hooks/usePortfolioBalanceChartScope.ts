import {useMemo, useRef} from 'react';
import type {Rates} from '../../../store/rate/rate.models';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {StoredWallet} from '../../core/types';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import type {CachedBalanceChartScope} from '../../../store/portfolio-charts';
import {
  buildBalanceChartScopeId,
  getSortedUniqueWalletIds,
} from '../../../utils/portfolio/chartCache';
import {
  buildCurrentSpotRatesByRateKey,
  getCurrentSpotRatesByRateKeySignature,
} from '../../../utils/portfolio/balanceChartData';
import {
  buildCommittedPortfolioRevisionToken,
  buildCurrentRatesByAssetId,
  getCurrentRatesByAssetIdSignature,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveCommittedPortfolioQuoteCurrency,
  resolveCurrentRatesAsOfMs,
} from '../common';

export type PortfolioBalanceChartScope = {
  asOfMs: number;
  cachedScope?: CachedBalanceChartScope;
  chartDataRevisionSig: string;
  currentRatesByAssetId: Record<string, number>;
  currentRatesSignature: string;
  currentSpotRatesByRateKey: Record<string, number>;
  currentSpotRatesSignature: string;
  eligibleWallets: Wallet[];
  quoteCurrency: string;
  scopeId: string;
  sortedWalletIds: string[];
  storedWalletRequestSig: string;
  storedWallets: StoredWallet[];
};

export function usePortfolioBalanceChartScope(args: {
  wallets: Wallet[];
  balanceOffset?: number;
  quoteCurrency?: string;
  rates?: Rates;
}): PortfolioBalanceChartScope {
  const dispatch = useAppDispatch();
  const defaultAltCurrencyIsoCode = useAppSelector(
    ({APP}) => APP.defaultAltCurrency?.isoCode,
  );
  const committedPortfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const committedPortfolioLastPopulatedAt = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.lastPopulatedAt,
  );
  const storeRates = useAppSelector(({RATE}) => RATE.rates);
  const ratesUpdatedAt = useAppSelector(({RATE}) => RATE.ratesUpdatedAt);

  const resolvedRates = args.rates ?? storeRates;
  const balanceOffset =
    typeof args.balanceOffset === 'number' && Number.isFinite(args.balanceOffset)
      ? args.balanceOffset
      : 0;

  const quoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
      portfolioQuoteCurrency:
        committedPortfolioQuoteCurrency || args.quoteCurrency,
      defaultAltCurrencyIsoCode,
    });
  }, [
    args.quoteCurrency,
    committedPortfolioQuoteCurrency,
    defaultAltCurrencyIsoCode,
  ]);

  const committedDataRevisionSig = useMemo(() => {
    return buildCommittedPortfolioRevisionToken({
      quoteCurrency:
        committedPortfolioQuoteCurrency ||
        args.quoteCurrency ||
        defaultAltCurrencyIsoCode,
      lastPopulatedAt: committedPortfolioLastPopulatedAt,
    });
  }, [
    args.quoteCurrency,
    committedPortfolioLastPopulatedAt,
    committedPortfolioQuoteCurrency,
    defaultAltCurrencyIsoCode,
  ]);

  const {storedWallets, eligibleWallets} = useMemo(() => {
    return mapWalletsToStoredWallets({
      dispatch,
      wallets: args.wallets,
    });
  }, [args.wallets, dispatch]);

  const sortedWalletIds = useMemo(
    () =>
      getSortedUniqueWalletIds(
        eligibleWallets.map(wallet => String(wallet?.id || '')),
      ),
    [eligibleWallets],
  );
  const storedWalletRequestSig = useMemo(
    () => getStoredWalletRequestSignature(storedWallets),
    [storedWallets],
  );
  const currentRatesByAssetId = useMemo(() => {
    return buildCurrentRatesByAssetId({
      storedWallets,
      quoteCurrency,
      rates: resolvedRates,
    });
  }, [quoteCurrency, resolvedRates, storedWallets]);
  const currentRatesSignature = useMemo(() => {
    return getCurrentRatesByAssetIdSignature(currentRatesByAssetId);
  }, [currentRatesByAssetId]);
  const currentSpotRatesByRateKey = useMemo(() => {
    return buildCurrentSpotRatesByRateKey({
      wallets: eligibleWallets,
      rates: resolvedRates,
      quoteCurrency,
    });
  }, [eligibleWallets, quoteCurrency, resolvedRates]);
  const currentSpotRatesSignature = useMemo(() => {
    return getCurrentSpotRatesByRateKeySignature(currentSpotRatesByRateKey);
  }, [currentSpotRatesByRateKey]);
  const fallbackAsOfMsRef = useRef<number>(Date.now());
  const asOfMs = useMemo(() => {
    return (
      resolveCurrentRatesAsOfMs({
        ratesUpdatedAt,
        rates: resolvedRates,
      }) ?? fallbackAsOfMsRef.current
    );
  }, [ratesUpdatedAt, resolvedRates]);
  const chartDataRevisionSig = useMemo(() => {
    return [committedDataRevisionSig, String(asOfMs)].join('|');
  }, [asOfMs, committedDataRevisionSig]);

  const scopeId = useMemo(() => {
    return buildBalanceChartScopeId({
      walletIds: sortedWalletIds,
      quoteCurrency,
      balanceOffset,
    });
  }, [balanceOffset, quoteCurrency, sortedWalletIds]);

  const cachedScope = useAppSelector(
    ({PORTFOLIO_CHARTS}) => PORTFOLIO_CHARTS.cacheByScopeId?.[scopeId],
  );

  return {
    asOfMs,
    cachedScope,
    chartDataRevisionSig,
    currentRatesByAssetId,
    currentRatesSignature,
    currentSpotRatesByRateKey,
    currentSpotRatesSignature,
    eligibleWallets,
    quoteCurrency,
    scopeId,
    sortedWalletIds,
    storedWalletRequestSig,
    storedWallets,
  };
}

export default usePortfolioBalanceChartScope;
