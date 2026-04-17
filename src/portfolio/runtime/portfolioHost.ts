import {
  PortfolioEngine,
  type PortfolioEngineOptions,
} from '../core/engine/portfolioEngine';
import type {
  WorkerMethod,
  WorkerRequest,
  WorkerResponse,
} from '../core/engine/workerProtocol';
import {
  DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY,
  MmkvKvStore,
  type WorkletMmkvStorageBridge,
} from '../adapters/rn/mmkvKvStore';
import {createPortfolioEngineOptionsForRnRuntime} from '../adapters/rn/portfolioEngineOptions';
import {createSerialExecutor} from './serialQueue';

export type PortfolioRuntimeHostConfig = {
  storage: WorkletMmkvStorageBridge;
  storageId?: string;
  registryKey?: string;
  engineOptions?: PortfolioEngineOptions;
};

export type PortfolioRuntimeHostBootstrapConfig = Pick<
  PortfolioRuntimeHostConfig,
  'storage' | 'storageId' | 'registryKey'
>;

type PortfolioRuntimeHostSingletonState = {
  host: PortfolioRuntimeHost;
  storageId?: string;
  registryKey?: string;
};

type GlobalWithPortfolioHost = typeof globalThis & {
  __bitpayPortfolioRuntimeHostV1__?: PortfolioRuntimeHostSingletonState;
};

const PORTFOLIO_HOST_GLOBAL_KEY = '__bitpayPortfolioRuntimeHostV1__';

export class PortfolioRuntimeHost {
  readonly engine: PortfolioEngine;

  private runSerial = createSerialExecutor();

  constructor(config: PortfolioRuntimeHostConfig) {
    const kv = new MmkvKvStore(config.storage, {
      storageId: config.storageId,
      registryKey: config.registryKey,
    });

    this.engine = new PortfolioEngine(
      kv,
      config.engineOptions ?? createPortfolioEngineOptionsForRnRuntime(),
    );
  }

  handle(req: WorkerRequest): Promise<WorkerResponse> {
    return this.runSerial(() => this.handleRequest(req));
  }

  private async handleRequest(
    req: WorkerRequest,
  ): Promise<WorkerResponse<WorkerMethod>> {
    try {
      switch (req.method) {
        case 'rates.ensure':
          await this.engine.ensureRates(req.params as any);
          return {id: req.id, ok: true, result: undefined} as any;

        case 'snapshots.getIndex': {
          const idx = await this.engine.getSnapshotIndex(
            (req.params as any).walletId,
          );
          return {id: req.id, ok: true, result: idx} as any;
        }

        case 'snapshots.clearWallet':
          await this.engine.clearWallet((req.params as any).walletId);
          return {id: req.id, ok: true, result: undefined} as any;

        case 'snapshots.prepareWallet': {
          const params = req.params as any;
          const res = await this.engine.prepareWalletSession({
            wallet: params.wallet,
            credentials: params.credentials,
            ingest: params.ingest,
            fetch: {
              cfg: params.cfg,
              pageSize: params.pageSize,
              emitRows: params.emitRows,
            },
          });
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'snapshots.closeWalletSession':
          await this.engine.closeWalletSession((req.params as any).walletId);
          return {id: req.id, ok: true, result: undefined} as any;

        case 'snapshots.processNextPage': {
          const res = await this.engine.processNextPageSession(
            (req.params as any).walletId,
          );
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'snapshots.finishWallet': {
          const res = await this.engine.finishWalletSession(
            (req.params as any).walletId,
          );
          return {id: req.id, ok: true, result: res as any} as any;
        }

        case 'snapshots.getLatestSnapshot': {
          const res = await this.engine.getLatestSnapshot(
            (req.params as any).walletId,
          );
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'snapshots.listSnapshots': {
          const res = await this.engine.listSnapshots(
            (req.params as any).walletId,
          );
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'analysis.compute': {
          const res = await this.engine.computeAnalysis(req.params as any);
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'analysis.computeChart': {
          const res = await this.engine.computeAnalysisChart(req.params as any);
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'debug.listRates': {
          const res = await this.engine.listCachedRates(req.params as any);
          return {id: req.id, ok: true, result: res} as any;
        }

        case 'debug.clearRates': {
          await this.engine.clearRates(req.params as any);
          return {id: req.id, ok: true, result: undefined} as any;
        }

        case 'debug.clearAll': {
          await this.engine.clearAllData();
          return {id: req.id, ok: true, result: undefined} as any;
        }

        case 'debug.kvStats': {
          const res = await this.engine.getKvStats();
          return {id: req.id, ok: true, result: res} as any;
        }

        default:
          throw new Error(`Unknown method: ${String((req as any).method)}`);
      }
    } catch (error: unknown) {
      const runtimeError =
        error instanceof Error ? error : new Error(String(error));

      return {
        id: req.id,
        ok: false,
        error: runtimeError.message || String(runtimeError),
        stack: runtimeError.stack,
      } as any;
    }
  }
}

export function getOrCreatePortfolioRuntimeHost(
  config: PortfolioRuntimeHostBootstrapConfig,
): PortfolioRuntimeHost {
  'worklet';

  const globalWithHost = globalThis as GlobalWithPortfolioHost;
  const existing = globalWithHost[PORTFOLIO_HOST_GLOBAL_KEY];
  const normalizedRegistryKey =
    config.registryKey ?? DEFAULT_PORTFOLIO_MMKV_REGISTRY_KEY;

  if (existing?.host) {
    const sameStorageId = existing.storageId === config.storageId;
    const sameRegistryKey = existing.registryKey === normalizedRegistryKey;

    if (!sameStorageId || !sameRegistryKey) {
      throw new Error(
        'Portfolio runtime host is already initialized with a different MMKV configuration.',
      );
    }

    return existing.host;
  }

  const host = new PortfolioRuntimeHost({
    storage: config.storage,
    storageId: config.storageId,
    registryKey: normalizedRegistryKey,
  });

  globalWithHost[PORTFOLIO_HOST_GLOBAL_KEY] = {
    host,
    storageId: config.storageId,
    registryKey: normalizedRegistryKey,
  };

  return host;
}

export function resetPortfolioRuntimeHostSingleton(): void {
  delete (globalThis as GlobalWithPortfolioHost)[PORTFOLIO_HOST_GLOBAL_KEY];
}
