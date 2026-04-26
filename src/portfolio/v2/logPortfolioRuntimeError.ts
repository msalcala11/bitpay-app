import type {PortfolioRuntimeKind} from './model';

export type PortfolioRuntimeLogExtra = Readonly<{
  tag?: string;
  reason?: string;
  errorName?: string;
  errorCode?: string;
  phase?: string;
  runtimeKind?: PortfolioRuntimeKind;
  walletCount?: number;
  assetGroupCount?: number;
  rateSourceCount?: number;
  pointCount?: number;
  retryAttempt?: number;
  startEpoch?: number;
  currentEpoch?: number;
  workEpoch?: number;
  warning?: boolean;
}>;

export type PortfolioRuntimeLogPayload = Readonly<
  PortfolioRuntimeLogExtra & {
    subsystem: 'portfolio-v2';
    errorName: string;
  }
>;

type PortfolioRuntimeLogSink = (payload: PortfolioRuntimeLogPayload) => void;

let runtimeLogSink: PortfolioRuntimeLogSink | undefined;
const runtimeLogPayloads: PortfolioRuntimeLogPayload[] = [];
const MAX_RECORDED_PORTFOLIO_RUNTIME_LOGS_FOR_DEBUG = 100;

// Local debug/test ring buffer only. Worklet runtimes have separate module
// heaps, so this is not an off-device telemetry sink and not a cross-runtime
// log transport.
const ALLOWED_EXTRA_KEYS: ReadonlyArray<keyof PortfolioRuntimeLogExtra> = [
  'tag',
  'reason',
  'errorName',
  'errorCode',
  'phase',
  'runtimeKind',
  'walletCount',
  'assetGroupCount',
  'rateSourceCount',
  'pointCount',
  'retryAttempt',
  'startEpoch',
  'currentEpoch',
  'workEpoch',
  'warning',
];

function sanitizeLogToken(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function getErrorName(err: unknown): string {
  if (err instanceof Error && err.name) {
    return sanitizeLogToken(err.name) ?? 'Error';
  }
  if (err && typeof err === 'object') {
    const candidate = (err as {name?: unknown}).name;
    const sanitized = sanitizeLogToken(candidate);
    if (sanitized) {
      return sanitized;
    }
  }
  return 'Error';
}

function sanitizeExtra(
  extra: PortfolioRuntimeLogExtra | undefined,
): PortfolioRuntimeLogExtra {
  if (!extra || typeof extra !== 'object') {
    return {};
  }

  const out: Record<string, string | number | boolean> = {};
  for (const key of ALLOWED_EXTRA_KEYS) {
    const value = extra[key];
    if (typeof value === 'string') {
      const sanitized = sanitizeLogToken(value);
      if (sanitized) {
        out[key] = sanitized;
      }
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) {
        out[key] = value;
      }
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out as PortfolioRuntimeLogExtra;
}

export function logPortfolioRuntimeError(
  err: unknown,
  extra?: PortfolioRuntimeLogExtra,
): void {
  try {
    const sanitizedExtra = sanitizeExtra(extra);
    const payload: PortfolioRuntimeLogPayload = {
      ...sanitizedExtra,
      subsystem: 'portfolio-v2',
      errorName: sanitizedExtra.errorName || getErrorName(err),
    };
    runtimeLogPayloads.push(payload);
    if (
      runtimeLogPayloads.length > MAX_RECORDED_PORTFOLIO_RUNTIME_LOGS_FOR_DEBUG
    ) {
      runtimeLogPayloads.splice(
        0,
        runtimeLogPayloads.length -
          MAX_RECORDED_PORTFOLIO_RUNTIME_LOGS_FOR_DEBUG,
      );
    }
    runtimeLogSink?.(payload);
  } catch {
    // Logging must never become a runtime failure source.
  }
}

export function setPortfolioRuntimeLogSinkForTesting(
  sink: PortfolioRuntimeLogSink | undefined,
): void {
  runtimeLogSink = sink;
}

export function getPortfolioRuntimeLogPayloadsForTesting(): PortfolioRuntimeLogPayload[] {
  return runtimeLogPayloads.slice();
}

export function clearPortfolioRuntimeLogPayloadsForTesting(): void {
  runtimeLogPayloads.length = 0;
  runtimeLogSink = undefined;
}
