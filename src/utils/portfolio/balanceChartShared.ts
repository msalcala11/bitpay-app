import type {GraphPoint} from 'react-native-graph';
import type {PnlAnalysisPoint} from './core/pnl/analysis';

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
};

export const normalizeBalanceChartOffset = (value: unknown): number => {
  return toFiniteNumber(value, 0);
};

export const normalizeBalanceChartWalletIds = (walletIds: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const walletId of walletIds || []) {
    const normalized = String(walletId || '');
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);
  }

  return out.sort((a, b) => a.localeCompare(b));
};

export const getSortedUniqueWalletIds = normalizeBalanceChartWalletIds;

export type BalanceChartSeries = {
  graphPoints: GraphPoint[];
  analysisPoints: PnlAnalysisPoint[];
  pointByTimestamp: Map<number, PnlAnalysisPoint>;
  minIndex: number;
  maxIndex: number;
  minPoint: GraphPoint;
  maxPoint: GraphPoint;
};

export const buildBalanceChartPointByTimestampMap = (args: {
  graphPoints: GraphPoint[];
  analysisPoints: PnlAnalysisPoint[];
}): Map<number, PnlAnalysisPoint> => {
  const pointByTimestamp = new Map<number, PnlAnalysisPoint>();
  const length = Math.min(args.graphPoints.length, args.analysisPoints.length);

  for (let i = 0; i < length; i++) {
    pointByTimestamp.set(args.graphPoints[i].date.getTime(), args.analysisPoints[i]);
  }

  return pointByTimestamp;
};
