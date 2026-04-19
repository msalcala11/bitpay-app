import {useIsFocused} from '@react-navigation/native';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import BalanceHistoryChart from '../../../../components/charts/BalanceHistoryChart';
import {ScreenGutter} from '../../../../components/styled/Containers';
import {HISTORIC_RATES_CACHE_DURATION} from '../../../../constants/wallet';
import {maybePopulatePortfolioForWallets} from '../../../../store/portfolio';
import {FIAT_RATE_SERIES_CACHED_INTERVALS} from '../../../../store/rate/rate.models';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {isPopulateLoadingForWallets} from '../../../../utils/portfolio/assets';
import {shouldUseCompactFiatAmountText} from '../../../../utils/fiatAmountText';
import useRuntimeFiatRateSeriesCache from '../../../../portfolio/ui/hooks/useRuntimeFiatRateSeriesCache';
import {
  getHistoricalRateAssetRequestFromItem,
  hasHistoricalRateSeriesForAsset,
} from '../../../tabs/home/hooks/portfolioAssetHistoryRequests';
import ExchangeRateScreenLayout from './ExchangeRateScreenLayout';
import useAssetScreenRefresh from './useAssetScreenRefresh';
import type {ExchangeRateSharedModel} from './useExchangeRateSharedModel';

type AssetBalanceHistoryScreenProps = {
  shared: ExchangeRateSharedModel;
};

const AssetBalanceHistoryScreen = ({
  shared,
}: AssetBalanceHistoryScreenProps) => {
  const dispatch = useAppDispatch();
  const isFocused = useIsFocused();
  const populateStatus = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.populateStatus,
  );
  const [selectedAssetBalance, setSelectedAssetBalance] = useState<
    number | undefined
  >(undefined);

  const historicalRateRequest = useMemo(() => {
    return getHistoricalRateAssetRequestFromItem(
      {
        currencyAbbreviation: shared.assetContext.currencyAbbreviation,
        chain: shared.assetContext.chain,
        tokenAddress: shared.assetContext.tokenAddress,
      },
      shared.resolvedQuoteCurrency,
    );
  }, [
    shared.assetContext.chain,
    shared.assetContext.currencyAbbreviation,
    shared.assetContext.tokenAddress,
    shared.resolvedQuoteCurrency,
  ]);

  const historicalRateRequests = useMemo(() => {
    if (!historicalRateRequest) {
      return [];
    }

    return [
      {
        coin: historicalRateRequest.coin,
        chain: historicalRateRequest.chain,
        tokenAddress: historicalRateRequest.tokenAddress,
        intervals: [...FIAT_RATE_SERIES_CACHED_INTERVALS],
      },
    ];
  }, [historicalRateRequest]);

  const {cache: fiatRateSeriesCache} = useRuntimeFiatRateSeriesCache({
    quoteCurrency: shared.resolvedQuoteCurrency,
    requests: historicalRateRequests,
    maxAgeMs: HISTORIC_RATES_CACHE_DURATION * 1000,
    enabled:
      !!shared.resolvedQuoteCurrency && historicalRateRequests.length > 0,
  });

  const hasHistoricalV4Rates = useMemo(() => {
    if (!historicalRateRequest) {
      return false;
    }

    return hasHistoricalRateSeriesForAsset({
      cache: fiatRateSeriesCache,
      fiatCode: shared.resolvedQuoteCurrency,
      intervals: FIAT_RATE_SERIES_CACHED_INTERVALS,
      coin: historicalRateRequest.coin,
      chain: historicalRateRequest.chain,
      tokenAddress: historicalRateRequest.tokenAddress,
    });
  }, [
    fiatRateSeriesCache,
    historicalRateRequest,
    shared.resolvedQuoteCurrency,
  ]);

  const isAssetBalanceChartLoading = useMemo(() => {
    return isPopulateLoadingForWallets({
      populateStatus,
      wallets: shared.assetWallets,
    });
  }, [populateStatus, shared.assetWallets]);

  useEffect(() => {
    setSelectedAssetBalance(undefined);
  }, [
    shared.assetContext.chain,
    shared.assetContext.currencyAbbreviation,
    shared.assetContext.tokenAddress,
  ]);

  useEffect(() => {
    if (
      !isFocused ||
      !shared.assetWallets.length ||
      populateStatus?.inProgress
    ) {
      return;
    }

    dispatch(
      maybePopulatePortfolioForWallets({
        wallets: shared.assetWallets,
        quoteCurrency: shared.resolvedQuoteCurrency,
      }),
    );
  }, [
    dispatch,
    isFocused,
    populateStatus?.inProgress,
    shared.assetWallets,
    shared.resolvedQuoteCurrency,
  ]);

  const refreshPortfolioSnapshots = useCallback(async () => {
    if (!shared.assetWallets.length) {
      return;
    }

    await dispatch(
      maybePopulatePortfolioForWallets({
        wallets: shared.assetWallets,
        quoteCurrency: shared.resolvedQuoteCurrency,
      }),
    );
  }, [dispatch, shared.assetWallets, shared.resolvedQuoteCurrency]);

  const {isRefreshing, onRefresh} = useAssetScreenRefresh(shared, {
    afterBaseRefresh: refreshPortfolioSnapshots,
  });

  const selectedAssetBalanceToDisplay = useMemo(() => {
    if (!shared.hasWalletsForAsset) {
      return undefined;
    }

    return selectedAssetBalance ?? shared.assetTotalFiatBalance;
  }, [
    selectedAssetBalance,
    shared.assetTotalFiatBalance,
    shared.hasWalletsForAsset,
  ]);

  const formattedAssetBalance = useMemo(() => {
    if (selectedAssetBalanceToDisplay == null) {
      return '--';
    }

    return formatFiatAmount(
      selectedAssetBalanceToDisplay,
      shared.resolvedQuoteCurrency,
      {
        currencyDisplay: 'symbol',
      },
    );
  }, [selectedAssetBalanceToDisplay, shared.resolvedQuoteCurrency]);

  const marketPriceDisplay = shared.formatDisplayPrice(shared.currentFiatRate);
  const shouldRenderBalanceChart = useMemo(() => {
    return (
      !shared.hideAllBalances &&
      (Number.isFinite(shared.currentFiatRate) || hasHistoricalV4Rates)
    );
  }, [hasHistoricalV4Rates, shared.currentFiatRate, shared.hideAllBalances]);

  const topValue = shared.hideAllBalances ? '****' : formattedAssetBalance;
  const topValueIsLarge = shouldUseCompactFiatAmountText(formattedAssetBalance);

  return (
    <ExchangeRateScreenLayout
      chartSection={
        shouldRenderBalanceChart ? (
          <BalanceHistoryChart
            wallets={shared.assetWallets}
            quoteCurrency={shared.resolvedQuoteCurrency}
            rates={shared.rates}
            lineColor={shared.chartLineColor}
            gradientStartColor={shared.gradientBackgroundColor}
            showLoaderWhenNoSnapshots={
              isAssetBalanceChartLoading || isRefreshing
            }
            onSelectedBalanceChange={setSelectedAssetBalance}
            timeframeSelectorHorizontalInset={ScreenGutter}
          />
        ) : null
      }
      isRefreshing={isRefreshing}
      marketPriceDisplay={marketPriceDisplay}
      onRefresh={onRefresh}
      shared={shared}
      topValue={topValue}
      topValueIsLarge={topValueIsLarge}
    />
  );
};

export default AssetBalanceHistoryScreen;
