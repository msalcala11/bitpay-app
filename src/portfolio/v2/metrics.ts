import type {PortfolioV2Metric} from './model';

type PortfolioV2MetricSink = (metric: PortfolioV2Metric) => void;

let metricSink: PortfolioV2MetricSink | undefined;
const recordedMetrics: PortfolioV2Metric[] = [];
const MAX_RECORDED_PORTFOLIO_V2_METRICS_FOR_DEBUG = 200;

// Local debug/test ring buffer only. Worklet runtimes have separate module
// heaps, so runtime-boundary tests must spy helper calls or install a sink in
// the runtime being exercised rather than treating this as shared telemetry.
function pushRecordedMetric(metric: PortfolioV2Metric): void {
  'worklet';

  recordedMetrics.push(metric);
  if (recordedMetrics.length > MAX_RECORDED_PORTFOLIO_V2_METRICS_FOR_DEBUG) {
    recordedMetrics.splice(
      0,
      recordedMetrics.length - MAX_RECORDED_PORTFOLIO_V2_METRICS_FOR_DEBUG,
    );
  }
}

export function recordPortfolioV2Metric(metric: PortfolioV2Metric): void {
  'worklet';

  pushRecordedMetric(metric);
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
  // avoids pulling TextEncoder into runtime paths. Non-ASCII is intentionally
  // overestimated so sharding never exceeds the warning budget because of UTF-8
  // multi-byte characters.
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    bytes += value.charCodeAt(i) <= 0x7f ? 1 : 3;
  }
  return bytes;
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
