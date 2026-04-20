import React, {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import BalanceHistoryChart, {
  type BalanceHistoryChartDiagnostics,
} from '../../../../components/charts/BalanceHistoryChart';
import {DEFAULT_BALANCE_CHART_TIMEFRAME, getRangeLabelForFiatTimeframe} from '../../../../components/charts/fiatTimeframes';
import {ScreenGutter} from '../../../../components/styled/Containers';
import type {FiatRateInterval} from '../../../../store/rate/rate.models';
import usePortfolioWalletSnapshotPresence from '../../../../portfolio/ui/hooks/usePortfolioWalletSnapshotPresence';
import {usePortfolioAnalysis} from '../../../../portfolio/ui/hooks/usePortfolioAnalysis';
import buildAssetPnlDebugPayload from '../../../../portfolio/ui/debug/buildAssetPnlDebugPayload';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import {useAppSelector} from '../../../../utils/hooks';
import {isPopulateLoadingForWallets} from '../../../../utils/portfolio/assets';
import {shouldUseCompactFiatAmountText} from '../../../../utils/fiatAmountText';
import ExchangeRateScreenLayout from './ExchangeRateScreenLayout';
import {
  buildAssetBalanceHistoryDisplayedSummary,
  buildAssetBalanceHistoryIdleSummary,
} from './assetBalanceHistorySummary';
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
  const [chartChangeRow, setChartChangeRow] = useState<
    | {
        percent: number;
        deltaFiatFormatted?: string;
        rangeLabel?: string;
      }
    | undefined
  >(undefined);
  const [selectionActive, setSelectionActive] = useState(false);
  const [chartDisplayedPoint, setChartDisplayedPoint] = useState<
    | {
        timestamp?: number;
        totalFiatBalance?: number;
        totalPnlChange?: number;
        totalPnlPercent?: number;
      }
    | undefined
  >(undefined);
  const [chartDiagnostics, setChartDiagnostics] = useState<
    BalanceHistoryChartDiagnostics | undefined
  >(undefined);
  const fundedAssetWallets = useMemo(() => {
    return shared.walletsForAsset.map(({wallet}) => wallet);
  }, [shared.walletsForAsset]);
  const {
    hasAllSnapshots: allAssetWalletsHaveSnapshots,
    checked: assetSnapshotsChecked,
  } = usePortfolioWalletSnapshotPresence({
    wallets: fundedAssetWallets,
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
    setChartChangeRow(undefined);
    setSelectionActive(false);
    setChartDisplayedPoint(undefined);
    setChartDiagnostics(undefined);
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

  const displayedSummary = useMemo(() => {
    return buildAssetBalanceHistoryDisplayedSummary({
      idleSummary,
      chartDisplayedPoint,
      chartChangeRow,
    });
  }, [chartChangeRow, chartDisplayedPoint, idleSummary]);

  const selectedAssetBalanceToDisplay = useMemo(() => {
    if (!shared.hasWalletsForAsset) {
      return undefined;
    }

    return displayedSummary.assetBalance ?? shared.assetTotalFiatBalance;
  }, [
    displayedSummary.assetBalance,
    shared.assetTotalFiatBalance,
    shared.hasWalletsForAsset,
  ]);

  const changeRow = useMemo(() => {
    return displayedSummary.changeRow;
  }, [displayedSummary.changeRow]);

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
  const topSectionDebugCopyPayload = useMemo(() => {
    const assetMetrics = idleSummary.assetMetrics;
    const renderedMetrics =
      displayedSummary.source === 'chart' && chartDisplayedPoint
      ? {
          fiatBalance:
            chartDisplayedPoint.totalFiatBalance ?? selectedAssetBalanceToDisplay,
          pnlChange: chartDisplayedPoint?.totalPnlChange,
          pnlPercent:
            chartDisplayedPoint?.totalPnlPercent ?? chartChangeRow?.percent,
          hasRate: assetMetrics?.hasRate ?? false,
          hasPnl:
            typeof chartDisplayedPoint?.totalPnlChange === 'number'
              ? true
              : assetMetrics?.hasPnl ?? false,
          showPnlPlaceholder: false,
        }
      : {
          fiatBalance: assetMetrics?.fiatValue ?? selectedAssetBalanceToDisplay,
          pnlChange: assetMetrics?.pnlFiat,
          pnlPercent: assetMetrics?.pnlPercent,
          hasRate: assetMetrics?.hasRate ?? false,
          hasPnl: assetMetrics?.hasPnl ?? false,
          showPnlPlaceholder: assetMetrics?.showPnlPlaceholder ?? false,
        };

    return buildAssetPnlDebugPayload({
      surface: selectionActive ? 'asset_details_selected' : 'asset_details_idle',
      assetKey: shared.assetContext.currencyAbbreviation.toLowerCase(),
      gainLossMode: selectedTimeframe,
      quoteCurrency: analysis.quoteCurrency || shared.resolvedQuoteCurrency,
      storedWallets: analysis.storedWallets,
      eligibleWallets: analysis.eligibleWallets,
      analysis: analysis.data,
      currentData: analysis.currentData,
      committedData: analysis.committedData,
      error: analysis.error,
      requestKey: analysis.requestKey,
      currentRatesByAssetId: analysis.currentRatesByAssetId,
      currentRatesSignature: analysis.currentRatesSignature,
      baseDebugPayload: assetMetrics?.debugCopyPayload,
      displayedMetrics: renderedMetrics,
      formattedDisplay: {
        topValue,
        formattedAssetBalance,
      },
      changeRow: changeRow
        ? {
            percent: changeRow.percent,
            deltaFiatFormatted: changeRow.deltaFiatFormatted,
            rangeLabel: changeRow.rangeLabel,
          }
        : undefined,
      selectionActive,
      selectedPoint: chartDisplayedPoint,
      extraDebugData: {
        shared: {
          assetContext: shared.assetContext,
          resolvedQuoteCurrency: shared.resolvedQuoteCurrency,
          hasWalletsForAsset: shared.hasWalletsForAsset,
          assetWalletIds: shared.assetWallets.map(wallet => String(wallet.id || '')),
          assetTotalFiatBalance: shared.assetTotalFiatBalance,
          currentFiatRate: shared.currentFiatRate ?? null,
        },
        detailState: {
          displaySource: displayedSummary.source,
          selectedTimeframe,
          idleRangeLabel,
          selectedAssetBalanceToDisplay: selectedAssetBalanceToDisplay ?? null,
          chartChangeRow: chartChangeRow || null,
          idleChangeRow: idleSummary.changeRow || null,
        },
        balanceChart: chartDiagnostics || null,
      },
    });
  }, [
    analysis.committedData,
    analysis.currentData,
    analysis.currentRatesByAssetId,
    analysis.currentRatesSignature,
    analysis.data,
    analysis.eligibleWallets,
    analysis.error,
    analysis.quoteCurrency,
    analysis.requestKey,
    analysis.storedWallets,
    changeRow,
    chartChangeRow,
    chartDiagnostics,
    chartDisplayedPoint,
    displayedSummary.source,
    formattedAssetBalance,
    idleRangeLabel,
    idleSummary.assetMetrics,
    idleSummary.changeRow,
    selectedAssetBalanceToDisplay,
    selectedTimeframe,
    selectionActive,
    shared.assetContext,
    shared.assetTotalFiatBalance,
    shared.assetWallets,
    shared.currentFiatRate,
    shared.hasWalletsForAsset,
    shared.resolvedQuoteCurrency,
    topValue,
  ]);

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
            onChangeRowData={setChartChangeRow}
            onDisplayedAnalysisPointChange={setChartDisplayedPoint}
            onDiagnosticsChange={setChartDiagnostics}
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
      reserveChangeRowSpace={shouldRenderBalanceChart}
      shared={shared}
      topValue={topValue}
      topValueIsLarge={topValueIsLarge}
      topSectionDebugCopyPayload={topSectionDebugCopyPayload}
    />
  );
};

export default AssetBalanceHistoryScreen;
