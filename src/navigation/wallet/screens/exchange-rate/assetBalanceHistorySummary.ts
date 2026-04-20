import {
  buildBalanceHistoryChartChangeRowData,
  type ChangeRowData,
} from '../../../../components/charts/balanceHistoryChartSelection';
import type {PnlAnalysisResult} from '../../../../portfolio/core/pnl/analysisStreaming';
import type {StoredWallet} from '../../../../portfolio/core/types';
import {
  buildAssetRowMetricsFromAnalysis,
  type AssetRowMetrics,
} from '../../../../portfolio/ui/selectors/buildAssetRowsFromAnalysis';
import type {GainLossMode} from '../../../../utils/portfolio/assets';

export type AssetBalanceHistoryIdleSummary = {
  assetBalance?: number;
  changeRow?: ChangeRowData;
  assetMetrics?: AssetRowMetrics;
};

export const buildAssetBalanceHistoryIdleSummary = (args: {
  storedWallets: StoredWallet[];
  analysis?: PnlAnalysisResult;
  quoteCurrency: string;
  rangeLabel: string;
  gainLossMode: GainLossMode;
  assetKey?: string;
}): AssetBalanceHistoryIdleSummary => {
  const rows = buildAssetRowMetricsFromAnalysis({
    storedWallets: args.storedWallets,
    analysis: args.analysis,
    gainLossMode: args.gainLossMode,
    collapseAcrossChains: true,
  });
  const normalizedAssetKey = String(args.assetKey || '').toLowerCase();
  const row =
    rows.find(candidate => candidate.key === normalizedAssetKey) ||
    (rows.length === 1 ? rows[0] : undefined);

  if (!row) {
    return {
      assetBalance: undefined,
      changeRow: undefined,
      assetMetrics: undefined,
    };
  }

  return {
    assetBalance:
      row.hasRate &&
      typeof row.fiatValue === 'number' &&
      Number.isFinite(row.fiatValue)
        ? row.fiatValue
        : undefined,
    assetMetrics: row,
    changeRow: row.showPnlPlaceholder
      ? undefined
      : buildBalanceHistoryChartChangeRowData({
          displayedAnalysisPoint: {
            totalPnlChange: row.pnlFiat,
            totalPnlPercent: row.pnlPercent,
          },
          quoteCurrency: args.quoteCurrency,
          label: args.rangeLabel,
        }),
  };
};
