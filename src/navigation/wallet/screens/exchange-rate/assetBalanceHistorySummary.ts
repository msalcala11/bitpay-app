import {
  buildBalanceHistoryChartChangeRowData,
  type ChangeRowData,
} from '../../../../components/charts/balanceHistoryChartSelection';
import type {PnlAnalysisResult} from '../../../../portfolio/core/pnl/analysisStreaming';

export type AssetBalanceHistoryIdleSummary = {
  assetBalance?: number;
  changeRow?: ChangeRowData;
};

const getLastAnalysisPoint = (
  analysis?: Pick<PnlAnalysisResult, 'points'>,
) => {
  const points = analysis?.points || [];
  return points.length ? points[points.length - 1] : undefined;
};

export const buildAssetBalanceHistoryIdleSummary = (args: {
  analysis?: Pick<PnlAnalysisResult, 'points'>;
  quoteCurrency: string;
  rangeLabel: string;
}): AssetBalanceHistoryIdleSummary => {
  const lastPoint = getLastAnalysisPoint(args.analysis);

  return {
    assetBalance:
      typeof lastPoint?.totalFiatBalance === 'number' &&
      Number.isFinite(lastPoint.totalFiatBalance)
        ? lastPoint.totalFiatBalance
        : undefined,
    changeRow: buildBalanceHistoryChartChangeRowData({
      displayedAnalysisPoint: lastPoint,
      quoteCurrency: args.quoteCurrency,
      label: args.rangeLabel,
    }),
  };
};

