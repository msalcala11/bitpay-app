import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
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
import {
  useDevLayoutTrace,
  useDevRenderTrace,
} from '../../../../utils/hooks/useDevRenderTrace';
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

const AssetBalanceChartSection = React.memo(
  ({
    shouldRender,
    wallets,
    quoteCurrency,
    initialSelectedTimeframe,
    rates,
    lineColor,
    gradientStartColor,
    showLoaderWhenNoSnapshots,
    onChangeRowData,
    onDisplayedAnalysisPointChange,
    onDiagnosticsChange,
    onSelectionActiveChange,
    onSelectedTimeframeChange,
  }: {
    shouldRender: boolean;
    wallets: ExchangeRateSharedModel['assetWallets'];
    quoteCurrency: string;
    initialSelectedTimeframe: FiatRateInterval;
    rates: ExchangeRateSharedModel['rates'];
    lineColor: string;
    gradientStartColor: string;
    showLoaderWhenNoSnapshots: boolean;
    onChangeRowData: (
      data:
        | {
            percent: number;
            deltaFiatFormatted?: string;
            rangeLabel?: string;
          }
        | undefined,
    ) => void;
    onDisplayedAnalysisPointChange: (
      point:
        | {
            timestamp?: number;
            totalFiatBalance?: number;
            totalPnlChange?: number;
            totalPnlPercent?: number;
          }
        | undefined,
    ) => void;
    onDiagnosticsChange: (
      diagnostics: BalanceHistoryChartDiagnostics | undefined,
    ) => void;
    onSelectionActiveChange: (active: boolean) => void;
    onSelectedTimeframeChange: (timeframe: FiatRateInterval) => void;
  }) => {
    const assetWalletIdsSignature = useMemo(() => {
      return wallets
        .map(wallet => String(wallet.id || ''))
        .sort()
        .join('|');
    }, [wallets]);
    const chartSectionOnLayout = useDevLayoutTrace(
      'AssetBalanceChartSectionLayout',
    );

    useDevRenderTrace('AssetBalanceChartSection', {
      shouldRender,
      quoteCurrency,
      initialSelectedTimeframe,
      assetWalletCount: wallets.length,
      assetWalletIdsSignature,
      showLoaderWhenNoSnapshots,
    });

    if (!shouldRender) {
      return null;
    }

    return (
      <View onLayout={chartSectionOnLayout}>
        <BalanceHistoryChart
          wallets={wallets}
          quoteCurrency={quoteCurrency}
          debugSource="asset_balance_history_chart"
          initialSelectedTimeframe={initialSelectedTimeframe}
          rates={rates}
          lineColor={lineColor}
          gradientStartColor={gradientStartColor}
          showLoaderWhenNoSnapshots={showLoaderWhenNoSnapshots}
          onChangeRowData={onChangeRowData}
          onDisplayedAnalysisPointChange={onDisplayedAnalysisPointChange}
          onDiagnosticsChange={onDiagnosticsChange}
          onSelectionActiveChange={onSelectionActiveChange}
          onSelectedTimeframeChange={onSelectedTimeframeChange}
          showChangeRow={false}
          timeframeSelectorHorizontalInset={ScreenGutter}
        />
      </View>
    );
  },
);

function areChartChangeRowsEqual(
  a:
    | {
        percent: number;
        deltaFiatFormatted?: string;
        rangeLabel?: string;
      }
    | undefined,
  b:
    | {
        percent: number;
        deltaFiatFormatted?: string;
        rangeLabel?: string;
      }
    | undefined,
): boolean {
  return (
    a?.percent === b?.percent &&
    a?.deltaFiatFormatted === b?.deltaFiatFormatted &&
    a?.rangeLabel === b?.rangeLabel
  );
}

function areDisplayedAnalysisPointsEqual(
  a:
    | {
        timestamp?: number;
        totalFiatBalance?: number;
        totalPnlChange?: number;
        totalPnlPercent?: number;
      }
    | undefined,
  b:
    | {
        timestamp?: number;
        totalFiatBalance?: number;
        totalPnlChange?: number;
        totalPnlPercent?: number;
      }
    | undefined,
): boolean {
  return (
    a?.timestamp === b?.timestamp &&
    a?.totalFiatBalance === b?.totalFiatBalance &&
    a?.totalPnlChange === b?.totalPnlChange &&
    a?.totalPnlPercent === b?.totalPnlPercent
  );
}

function areChartDiagnosticsEqual(
  a: BalanceHistoryChartDiagnostics | undefined,
  b: BalanceHistoryChartDiagnostics | undefined,
): boolean {
  return (
    a?.timeframe === b?.timeframe &&
    a?.displayedTimeframe === b?.displayedTimeframe &&
    a?.queryRevisionKey === b?.queryRevisionKey &&
    a?.quoteCurrency === b?.quoteCurrency &&
    a?.cachedSelectedTimeframeStatus === b?.cachedSelectedTimeframeStatus &&
    a?.loading === b?.loading &&
    a?.hasRenderableSeries === b?.hasRenderableSeries &&
    a?.selectionActive === b?.selectionActive &&
    a?.renderedSeriesPointsCount === b?.renderedSeriesPointsCount &&
    a?.displayedAnalysisPoint?.timestamp === b?.displayedAnalysisPoint?.timestamp &&
    a?.displayedAnalysisPoint?.totalFiatBalance ===
      b?.displayedAnalysisPoint?.totalFiatBalance &&
    a?.displayedAnalysisPoint?.totalPnlChange ===
      b?.displayedAnalysisPoint?.totalPnlChange &&
    a?.displayedAnalysisPoint?.totalPnlPercent ===
      b?.displayedAnalysisPoint?.totalPnlPercent
  );
}

const AssetBalanceHistoryScreen = ({
  shared,
}: AssetBalanceHistoryScreenProps) => {
  const {t} = useTranslation();
  const populateStatus = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.populateStatus,
  );
  const [displayedTimeframe, setDisplayedTimeframe] = useState<FiatRateInterval>(
    DEFAULT_BALANCE_CHART_TIMEFRAME,
  );
  const [requestedTimeframe, setRequestedTimeframe] = useState<FiatRateInterval>(
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
  const {
    hasAnySnapshots: anyAssetWalletHasSnapshots,
    checked: assetSnapshotsChecked,
  } = usePortfolioWalletSnapshotPresence({
    wallets: shared.assetWallets,
    enabled: shared.hasWalletsForAsset,
  });
  const analysis = usePortfolioAnalysis({
    wallets: shared.assetWallets,
    timeframe: displayedTimeframe,
    maxPoints: 2,
    enabled: shared.hasWalletsForAsset,
    freezeWhilePopulate: true,
    allowCurrentWhilePopulate: true,
    debugSource: 'asset_balance_history_analysis',
  });

  const isAssetBalanceChartLoading = useMemo(() => {
    return isPopulateLoadingForWallets({
      populateStatus,
      wallets: shared.assetWallets,
    });
  }, [populateStatus, shared.assetWallets]);
  const isTimeframeTransitionPending =
    requestedTimeframe !== displayedTimeframe;

  useEffect(() => {
    setChartChangeRow(undefined);
    setSelectionActive(false);
    setChartDisplayedPoint(undefined);
    setChartDiagnostics(undefined);
    setDisplayedTimeframe(DEFAULT_BALANCE_CHART_TIMEFRAME);
    setRequestedTimeframe(DEFAULT_BALANCE_CHART_TIMEFRAME);
  }, [
    shared.assetContext.chain,
    shared.assetContext.currencyAbbreviation,
    shared.assetContext.tokenAddress,
  ]);

  const idleRangeLabel = useMemo(() => {
    return getRangeLabelForFiatTimeframe(t, displayedTimeframe);
  }, [displayedTimeframe, t]);

  const idleSummary = useMemo(() => {
    return buildAssetBalanceHistoryIdleSummary({
      storedWallets: analysis.storedWallets,
      analysis: analysis.data,
      quoteCurrency: analysis.quoteCurrency || shared.resolvedQuoteCurrency,
      rangeLabel: idleRangeLabel,
      gainLossMode: displayedTimeframe,
      assetKey: shared.assetContext.currencyAbbreviation.toLowerCase(),
    });
  }, [
    analysis.data,
    analysis.quoteCurrency,
    analysis.storedWallets,
    displayedTimeframe,
    idleRangeLabel,
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
  const assetWalletIdsSignature = useMemo(() => {
    return shared.assetWallets
      .map(wallet => String(wallet.id || ''))
      .sort()
      .join('|');
  }, [shared.assetWallets]);
  const changeRowSignature = useMemo(() => {
    return changeRow
      ? [
          changeRow.percent,
          changeRow.deltaFiatFormatted || '',
          changeRow.rangeLabel || '',
        ].join('|')
      : '';
  }, [changeRow]);
  const shouldRenderBalanceChart = useMemo(() => {
    return (
      !shared.hideAllBalances &&
      shared.hasWalletsForAsset
    );
  }, [
    shared.hideAllBalances,
    shared.hasWalletsForAsset,
  ]);

  useDevRenderTrace('AssetBalanceHistoryScreen', {
    assetKey: [
      shared.assetContext.currencyAbbreviation,
      shared.assetContext.chain,
      shared.assetContext.tokenAddress || '',
    ].join(':'),
    displayedTimeframe,
    requestedTimeframe,
    selectionActive,
    shouldRenderBalanceChart,
    hasWalletsForAsset: shared.hasWalletsForAsset,
    assetWalletCount: shared.assetWallets.length,
    assetWalletIdsSignature,
    currentFiatRate: shared.currentFiatRate ?? null,
    assetTotalFiatBalance: shared.assetTotalFiatBalance,
    snapshotsChecked: assetSnapshotsChecked,
    anyAssetWalletHasSnapshots,
    isAssetBalanceChartLoading,
    isRefreshing,
    analysisRequestKey: analysis.requestKey,
    analysisLoading: analysis.loading,
    analysisHasData: !!analysis.data,
    analysisHasCommittedData: !!analysis.committedData,
    displayedSummarySource: displayedSummary.source,
    chartDiagnosticsTimeframe: chartDiagnostics?.timeframe ?? null,
    chartDiagnosticsDisplayedTimeframe:
      chartDiagnostics?.displayedTimeframe ?? null,
    chartDiagnosticsLoading: chartDiagnostics?.loading ?? null,
    chartRenderedPoints: chartDiagnostics?.renderedSeriesPointsCount ?? null,
    changeRowSignature,
    marketPriceDisplay,
  });

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
      gainLossMode: displayedTimeframe,
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
          displayedTimeframe,
          requestedTimeframe,
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
    displayedTimeframe,
    requestedTimeframe,
    selectionActive,
    shared.assetContext,
    shared.assetTotalFiatBalance,
    shared.assetWallets,
    shared.currentFiatRate,
    shared.hasWalletsForAsset,
    shared.resolvedQuoteCurrency,
    topValue,
  ]);

  const handleChartChangeRowData = useCallback(
    (
      nextChartChangeRow:
        | {
            percent: number;
            deltaFiatFormatted?: string;
            rangeLabel?: string;
          }
        | undefined,
    ) => {
      setChartChangeRow(prev =>
        areChartChangeRowsEqual(prev, nextChartChangeRow)
          ? prev
          : nextChartChangeRow,
      );
    },
    [],
  );

  const handleDisplayedAnalysisPointChange = useCallback(
    (
      nextDisplayedPoint:
        | {
            timestamp?: number;
            totalFiatBalance?: number;
            totalPnlChange?: number;
            totalPnlPercent?: number;
          }
        | undefined,
    ) => {
      setChartDisplayedPoint(prev =>
        areDisplayedAnalysisPointsEqual(prev, nextDisplayedPoint)
          ? prev
          : nextDisplayedPoint,
      );
    },
    [],
  );

  const handleChartDiagnosticsChange = useCallback(
    (nextDiagnostics: BalanceHistoryChartDiagnostics | undefined) => {
      if (nextDiagnostics?.displayedTimeframe) {
        setDisplayedTimeframe(prev =>
          prev === nextDiagnostics.displayedTimeframe
            ? prev
            : nextDiagnostics.displayedTimeframe,
        );
      }

      setChartDiagnostics(prev =>
        areChartDiagnosticsEqual(prev, nextDiagnostics)
          ? prev
          : nextDiagnostics,
      );
    },
    [],
  );

  const handleSelectedTimeframeChange = useCallback(
    (nextTimeframe: FiatRateInterval) => {
      setRequestedTimeframe(prev =>
        prev === nextTimeframe ? prev : nextTimeframe,
      );
    },
    [],
  );

  return (
    <ExchangeRateScreenLayout
      changeRow={changeRow}
      chartSection={
        <AssetBalanceChartSection
          shouldRender={shouldRenderBalanceChart}
          wallets={shared.assetWallets}
          quoteCurrency={shared.resolvedQuoteCurrency}
          initialSelectedTimeframe={displayedTimeframe}
          rates={shared.rates}
          lineColor={shared.chartLineColor}
          gradientStartColor={shared.gradientBackgroundColor}
          showLoaderWhenNoSnapshots={
            isAssetBalanceChartLoading ||
            isRefreshing ||
            isTimeframeTransitionPending
          }
          onChangeRowData={handleChartChangeRowData}
          onDisplayedAnalysisPointChange={handleDisplayedAnalysisPointChange}
          onDiagnosticsChange={handleChartDiagnosticsChange}
          onSelectionActiveChange={setSelectionActive}
          onSelectedTimeframeChange={handleSelectedTimeframeChange}
        />
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
