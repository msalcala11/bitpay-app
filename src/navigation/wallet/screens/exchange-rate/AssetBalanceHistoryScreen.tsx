import React, {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import BalanceHistoryChart from '../../../../components/charts/BalanceHistoryChart';
import {DEFAULT_BALANCE_CHART_TIMEFRAME, getRangeLabelForFiatTimeframe} from '../../../../components/charts/fiatTimeframes';
import {ScreenGutter} from '../../../../components/styled/Containers';
import type {FiatRateInterval} from '../../../../store/rate/rate.models';
import usePortfolioWalletSnapshotPresence from '../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence';
import {usePortfolioAnalysis} from '../../../../portfolio/ui/hooks/usePortfolioAnalysis';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import {useAppSelector} from '../../../../utils/hooks';
import {isPopulateLoadingForWallets} from '../../../../utils/portfolio/assets';
import {shouldUseCompactFiatAmountText} from '../../../../utils/fiatAmountText';
import ExchangeRateScreenLayout from './ExchangeRateScreenLayout';
import {buildAssetBalanceHistoryIdleSummary} from './assetBalanceHistorySummary';
import useAssetScreenRefresh from './useAssetScreenRefresh';
import type {ExchangeRateSharedModel} from './useExchangeRateSharedModel';

type AssetBalanceHistoryScreenProps = {
  shared: ExchangeRateSharedModel;
};

const AssetBalanceHistoryScreen = ({
  shared,
}: AssetBalanceHistoryScreenProps) => {
  const {t} = useTranslation();
  const populateStatus = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.populateStatus,
  );
  const [selectedTimeframe, setSelectedTimeframe] = useState<FiatRateInterval>(
    DEFAULT_BALANCE_CHART_TIMEFRAME,
  );
  const [selectedAssetBalance, setSelectedAssetBalance] = useState<
    number | undefined
  >(undefined);
  const [selectedChangeRow, setSelectedChangeRow] = useState<
    | {
        percent: number;
        deltaFiatFormatted?: string;
        rangeLabel?: string;
      }
    | undefined
  >(undefined);
  const [selectionActive, setSelectionActive] = useState(false);
  const {
    hasAllSnapshots: allAssetWalletsHaveSnapshots,
    checked: assetSnapshotsChecked,
  } = usePortfolioWalletSnapshotPresence({
    wallets: shared.assetWallets,
  });
  const analysis = usePortfolioAnalysis({
    wallets: shared.assetWallets,
    timeframe: selectedTimeframe,
    maxPoints: 2,
    enabled: shared.hasWalletsForAsset,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: true,
  });

  const isAssetBalanceChartLoading = useMemo(() => {
    return isPopulateLoadingForWallets({
      populateStatus,
      wallets: shared.assetWallets,
    });
  }, [populateStatus, shared.assetWallets]);

  useEffect(() => {
    setSelectedAssetBalance(undefined);
    setSelectedChangeRow(undefined);
    setSelectionActive(false);
    setSelectedTimeframe(DEFAULT_BALANCE_CHART_TIMEFRAME);
  }, [
    shared.assetContext.chain,
    shared.assetContext.currencyAbbreviation,
    shared.assetContext.tokenAddress,
  ]);

  const idleRangeLabel = useMemo(() => {
    return getRangeLabelForFiatTimeframe(t, selectedTimeframe);
  }, [selectedTimeframe, t]);

  const idleSummary = useMemo(() => {
    return buildAssetBalanceHistoryIdleSummary({
      storedWallets: analysis.storedWallets,
      analysis: analysis.data,
      quoteCurrency: analysis.quoteCurrency || shared.resolvedQuoteCurrency,
      rangeLabel: idleRangeLabel,
      gainLossMode: selectedTimeframe,
      assetKey: shared.assetContext.currencyAbbreviation.toLowerCase(),
    });
  }, [
    analysis.data,
    analysis.quoteCurrency,
    analysis.storedWallets,
    idleRangeLabel,
    selectedTimeframe,
    shared.assetContext.currencyAbbreviation,
    shared.resolvedQuoteCurrency,
  ]);

  const {isRefreshing, onRefresh} = useAssetScreenRefresh(shared);

  const selectedAssetBalanceToDisplay = useMemo(() => {
    if (!shared.hasWalletsForAsset) {
      return undefined;
    }

    return (
      (selectionActive ? selectedAssetBalance : undefined) ??
      idleSummary.assetBalance ??
      shared.assetTotalFiatBalance
    );
  }, [
    idleSummary.assetBalance,
    selectionActive,
    selectedAssetBalance,
    shared.assetTotalFiatBalance,
    shared.hasWalletsForAsset,
  ]);

  const changeRow = useMemo(() => {
    if (!selectionActive) {
      return idleSummary.changeRow;
    }

    return selectedChangeRow ?? idleSummary.changeRow;
  }, [idleSummary.changeRow, selectedChangeRow, selectionActive]);

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
      changeRow={changeRow}
      chartSection={
        shouldRenderBalanceChart ? (
          <BalanceHistoryChart
            wallets={shared.assetWallets}
            quoteCurrency={shared.resolvedQuoteCurrency}
            initialSelectedTimeframe={selectedTimeframe}
            rates={shared.rates}
            lineColor={shared.chartLineColor}
            gradientStartColor={shared.gradientBackgroundColor}
            showLoaderWhenNoSnapshots={
              isAssetBalanceChartLoading || isRefreshing
            }
            onSelectedBalanceChange={setSelectedAssetBalance}
            onChangeRowData={setSelectedChangeRow}
            onSelectionActiveChange={setSelectionActive}
            onSelectedTimeframeChange={setSelectedTimeframe}
            showChangeRow={false}
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
