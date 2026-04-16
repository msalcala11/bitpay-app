import {BASE_BWS_URL, BWC_TIMEOUT} from '../../constants/config';
import {CANONICAL_FIAT_QUOTE} from '../core/fiatRatesShared';
import type {BwsConfig} from '../core/shared/bws';
import type {StoredWallet} from '../core/types';
import type {SnapshotIngestConfig} from '../core/engine/portfolioEngine';
import {
  isTerminalPortfolioPopulateJobStatus,
  type PortfolioPopulateProgress,
  type PortfolioPopulateRunResult,
  type PortfolioPopulateWalletRunResult,
} from '../core/engine/populateJob';
import type {PortfolioRuntimeClient} from '../runtime/portfolioClient';

export type {
  PortfolioPopulateProgress,
  PortfolioPopulateRunResult,
  PortfolioPopulateWalletRunResult,
} from '../core/engine/populateJob';

export type PortfolioPopulateServiceOptions = {
  client: PortfolioRuntimeClient;
  bwsConfig?: BwsConfig;
  ingestConfig?: Partial<SnapshotIngestConfig>;
  pageSize?: number;
  emitRows?: number;
  pollIntervalMs?: number;
};

const PORTFOLIO_POPULATE_ABORTED_ERROR_MESSAGE = 'PORTFOLIO_POPULATE_ABORTED';
const DEFAULT_POLL_INTERVAL_MS = 500;

function createDefaultBwsConfig(): BwsConfig {
  return {
    baseUrl: BASE_BWS_URL,
    timeoutMs: BWC_TIMEOUT,
  };
}

function createDefaultIngestConfig(): SnapshotIngestConfig {
  return {
    quoteCurrency: CANONICAL_FIAT_QUOTE,
    compressionEnabled: true,
    chunkRows: 128,
    snapshotDebugMode: 'none',
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)), undefined);
  });
}

function toProgress(status: {
  inProgress: boolean;
  startedAt: number;
  currentWalletId?: string;
  walletsTotal: number;
  walletsCompleted: number;
  txRequestsMade: number;
  txsProcessed: number;
  walletStatusById: {[walletId: string]: any};
  errors: Array<{walletId: string; message: string}>;
}): PortfolioPopulateProgress {
  return {
    inProgress: status.inProgress,
    startedAt: status.startedAt,
    currentWalletId: status.currentWalletId,
    walletsTotal: status.walletsTotal,
    walletsCompleted: status.walletsCompleted,
    txRequestsMade: status.txRequestsMade,
    txsProcessed: status.txsProcessed,
    walletStatusById: {...(status.walletStatusById || {})},
    errors: Array.isArray(status.errors)
      ? status.errors.map(error => ({...error}))
      : [],
  };
}

function buildFallbackRunResult(status: {
  startedAt: number;
  finishedAt?: number;
  disabledForLargeHistory?: boolean;
  state?: string;
}): PortfolioPopulateRunResult {
  return {
    startedAt: status.startedAt,
    finishedAt: Number(status.finishedAt || Date.now()),
    cancelled: status.state === 'cancelled',
    disabledForLargeHistory: status.disabledForLargeHistory === true,
    results: [],
  };
}

function toJobFailureMessage(status: {
  failureMessage?: string;
  errors?: Array<{message?: string}>;
}): string {
  const firstError = Array.isArray(status.errors) ? status.errors[0] : undefined;
  return (
    String(status.failureMessage || '').trim() ||
    String(firstError?.message || '').trim() ||
    'Portfolio populate job failed.'
  );
}

export class PortfolioPopulateService {
  private client: PortfolioRuntimeClient;
  private bwsConfig: BwsConfig;
  private ingestConfig: SnapshotIngestConfig;
  private pageSize: number;
  private emitRows?: number;
  private pollIntervalMs: number;
  private cancelRequested = false;
  private activeJobId: string | undefined;
  private cancelSent = false;

  constructor(options: PortfolioPopulateServiceOptions) {
    this.client = options.client;
    this.bwsConfig = options.bwsConfig ?? createDefaultBwsConfig();
    this.ingestConfig = {
      ...createDefaultIngestConfig(),
      ...(options.ingestConfig || {}),
      quoteCurrency: CANONICAL_FIAT_QUOTE,
      snapshotDebugMode: options.ingestConfig?.snapshotDebugMode ?? 'none',
    };
    this.pageSize =
      typeof options.pageSize === 'number' && Number.isFinite(options.pageSize)
        ? Math.max(1, Math.floor(options.pageSize))
        : 1000;
    this.emitRows =
      typeof options.emitRows === 'number' && Number.isFinite(options.emitRows)
        ? Math.max(1, Math.floor(options.emitRows))
        : undefined;
    this.pollIntervalMs =
      typeof options.pollIntervalMs === 'number' &&
      Number.isFinite(options.pollIntervalMs)
        ? Math.max(100, Math.floor(options.pollIntervalMs))
        : DEFAULT_POLL_INTERVAL_MS;
  }

  cancel(): void {
    this.cancelRequested = true;
    if (this.activeJobId && !this.cancelSent) {
      this.cancelSent = true;
      void this.client.cancelPopulateJob({jobId: this.activeJobId}).catch(() => {
        this.cancelSent = false;
      });
    }
  }

  resetCancel(): void {
    this.cancelRequested = false;
    this.cancelSent = false;
  }

  isCancelled(): boolean {
    return this.cancelRequested;
  }

  async populateWallets(args: {
    wallets: StoredWallet[];
    onProgress?: (progress: PortfolioPopulateProgress) => void;
  }): Promise<PortfolioPopulateRunResult> {
    this.resetCancel();
    this.activeJobId = undefined;

    const start = await this.client.startPopulateJob({
      cfg: this.bwsConfig,
      wallets: args.wallets || [],
      ingest: this.ingestConfig,
      pageSize: this.pageSize,
      emitRows: this.emitRows,
    });

    this.activeJobId = start.jobId;
    let lastUpdatedAt = -1;
    let lastState = '';

    while (true) {
      if (this.cancelRequested && this.activeJobId && !this.cancelSent) {
        this.cancelSent = true;
        await this.client
          .cancelPopulateJob({jobId: this.activeJobId})
          .catch(() => undefined);
      }

      const status = await this.client.getPopulateJobStatus({
        jobId: this.activeJobId,
      });

      if (!status) {
        throw new Error('Portfolio populate job status is unavailable on the runtime.');
      }

      if (
        status.lastUpdatedAt !== lastUpdatedAt ||
        status.state !== lastState ||
        status.inProgress === false
      ) {
        args.onProgress?.(toProgress(status));
        lastUpdatedAt = status.lastUpdatedAt;
        lastState = status.state;
      }

      if (isTerminalPortfolioPopulateJobStatus(status)) {
        this.activeJobId = undefined;

        if (status.state === 'failed') {
          throw new Error(toJobFailureMessage(status));
        }

        return status.result || buildFallbackRunResult(status);
      }

      await delay(this.pollIntervalMs);
    }
  }
}

export function throwIfPortfolioPopulateCancelled(
  service: Pick<PortfolioPopulateService, 'isCancelled'>,
): void {
  if (service.isCancelled()) {
    throw new Error(PORTFOLIO_POPULATE_ABORTED_ERROR_MESSAGE);
  }
}
