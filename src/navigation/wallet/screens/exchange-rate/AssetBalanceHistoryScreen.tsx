import React, {useEffect, useMemo, useState} from 'react';
import BalanceHistoryChart from '../../../../components/charts/BalanceHistoryChart';
import {ScreenGutter} from '../../../../components/styled/Containers';
import usePortfolioWalletSnapshotPresence from '../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import {useAppSelector} from '../../../../utils/hooks';
import {isPopulateLoadingForWallets} from '../../../../utils/portfolio/assets';
import {shouldUseCompactFiatAmountText} from '../../../../utils/fiatAmountText';
import ExchangeRateScreenLayout from './ExchangeRateScreenLayout';
import useAssetScreenRefresh from './useAssetScreenRefresh';
import type {ExchangeRateSharedModel} from './useExchangeRateSharedModel';

type AssetBalanceHistoryScreenProps = {
  shared: ExchangeRateSharedModel;
};

const AssetBalanceHistoryScreen = ({
  shared,
}: AssetBalanceHistoryScreenProps) => {
  const populateStatus = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.populateStatus,
  );
  const [selectedAssetBalance, setSelectedAssetBalance] = useState<
    number | undefined
  >(undefined);
  const {
    hasAllSnapshots: allAssetWalletsHaveSnapshots,
    checked: assetSnapshotsChecked,
  } = usePortfolioWalletSnapshotPresence({
    wallets: shared.assetWallets,
  });

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

  const {isRefreshing, onRefresh} = useAssetScreenRefresh(shared);

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
      (!assetSnapshotsChecked || allAssetWalletsHaveSnapshots)
    );
  }, [
    allAssetWalletsHaveSnapshots,
    assetSnapshotsChecked,
    shared.hideAllBalances,
  ]);

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
