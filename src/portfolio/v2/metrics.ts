import type {PortfolioV2Metric} from './model';

type PortfolioV2MetricSink = (metric: PortfolioV2Metric) => void;

let metricSink: PortfolioV2MetricSink | undefined;
const recordedMetrics: PortfolioV2Metric[] = [];

export function recordPortfolioV2Metric(metric: PortfolioV2Metric): void {
  'worklet';

  recordedMetrics.push(metric);
  metricSink?.(metric);
}

export function setPortfolioV2MetricSinkForTesting(
  sink: PortfolioV2MetricSink | undefined,
): void {
  metricSink = sink;
}

export function getRecordedPortfolioV2MetricsForTesting(): PortfolioV2Metric[] {
  return recordedMetrics.slice();
}

export function clearRecordedPortfolioV2MetricsForTesting(): void {
  recordedMetrics.length = 0;
  metricSink = undefined;
}

export function approximateStringBytes(value: string): number {
  'worklet';

  // Good enough for warning thresholds, deterministic in worklet/JS tests, and
  // avoids pulling TextEncoder into runtime paths.
  return value.length;
}

export function approximateJsonBytes(value: unknown): number {
  'worklet';

  try {
    return approximateStringBytes(JSON.stringify(value));
  } catch {
    return 0;
  }
}

export function nowMs(): number {
  'worklet';

  const candidate = globalThis?.performance?.now?.();
  return Number.isFinite(candidate) ? Number(candidate) : Date.now();
}
