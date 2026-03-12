import type {GraphPoint} from 'react-native-graph';
import type {PnlAnalysisPoint} from '../../utils/portfolio/core/pnl/analysis';

export type ComputedSeries = {
  graphPoints: GraphPoint[];
  analysisPoints: PnlAnalysisPoint[];
  pointByTimestamp: Map<number, PnlAnalysisPoint>;
  minIndex: number;
  maxIndex: number;
  minPoint: GraphPoint;
  maxPoint: GraphPoint;
};

export type ChangeRowData = {
  percent: number;
  deltaFiatFormatted?: string;
  rangeLabel?: string;
};
