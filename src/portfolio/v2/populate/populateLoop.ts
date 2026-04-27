import {
  getPortfolioMmkvNativeStorageOnRN,
  PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
  PORTFOLIO_WORKLET_MMKV_STORAGE_ID,
} from '../../adapters/rn/workletMmkvBridge';
import type {PortfolioPopulateJobStartResult} from '../../core/engine/populateJob';
import {
  handleGetPopulateJobStatusOnWorklet,
  handleStartPopulateJobOnWorklet,
} from '../../runtime/worklet/portfolioPopulateJobWorklet';
import type {PortfolioPopulateJobSigningContextMap} from '../../runtime/worklet/portfolioPopulateJobWorklet';
import type {PortfolioPopulateWorkletConfig} from '../../runtime/worklet/portfolioPopulateWorklet';
import {PORTFOLIO_SNAPSHOT_CHUNK_ROW_BUDGET} from '../constants';
import {logPortfolioRuntimeError} from '../logPortfolioRuntimeError';
import type {PopulateQueueItem} from '../model';
import {
  buildPopulateRuntimeContextFromStore,
  type PopulateRuntimeContext,
  type PopulateRuntimeWalletContext,
} from '../reduxAccess';
import {
  getPortfolioPopulateRuntime,
  logFireAndForgetRuntimeError,
  runOnPortfolioRuntimeAsync,
} from '../runtimes';
import {
  populateLoopRunning,
  populateProgressTick,
  populateRetryTick,
} from '../sharedState';
import {loadQueue} from './queue';

const POPULATE_JOB_POLL_MS = 250;

function delayOnPopulateRuntime(ms: number): Promise<void> {
  'worklet';

  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function uniqueOrderedWalletIds(
  items: readonly PopulateQueueItem[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const walletId = String(item.walletId || '').trim();
    if (!walletId || seen.has(walletId)) {
      continue;
    }
    seen.add(walletId);
    out.push(walletId);
  }
  return out;
}

function queuedWalletIds(): readonly string[] {
  const queue = loadQueue();
  if (!queue?.pending.length && !queue?.active) {
    return [];
  }

  return uniqueOrderedWalletIds([
    ...(queue.active ? [queue.active] : []),
    ...(queue.pending || []),
  ]);
}

function selectWalletsForPopulate(args: {
  ctx: PopulateRuntimeContext;
  walletIds: readonly string[];
}): PopulateRuntimeWalletContext[] {
  const out: PopulateRuntimeWalletContext[] = [];
  for (const walletId of args.walletIds) {
    const wallet = args.ctx.walletsById[walletId];
    if (wallet) {
      out.push(wallet);
    }
  }
  return out;
}

function buildPopulateWorkletConfig(): PortfolioPopulateWorkletConfig {
  return {
    storage: getPortfolioMmkvNativeStorageOnRN(),
    storageId: PORTFOLIO_WORKLET_MMKV_STORAGE_ID,
    registryKey: PORTFOLIO_WORKLET_MMKV_REGISTRY_KEY,
  };
}

async function runPopulateJobOnWorklet(
  config: PortfolioPopulateWorkletConfig,
  params: Parameters<typeof handleStartPopulateJobOnWorklet>[1],
  signingContextsByWalletId?: PortfolioPopulateJobSigningContextMap,
): Promise<PortfolioPopulateJobStartResult> {
  'worklet';

  const started = await handleStartPopulateJobOnWorklet(
    config,
    params,
    signingContextsByWalletId,
  );
  const jobId = String(started?.jobId || '').trim();
  if (!jobId) {
    throw new Error('Populate worklet did not return a job id.');
  }

  let status = started.status;
  if (!status) {
    throw new Error(`Populate worklet job ${jobId} did not return status.`);
  }
  while (status?.inProgress) {
    await delayOnPopulateRuntime(POPULATE_JOB_POLL_MS);
    const nextStatus = await handleGetPopulateJobStatusOnWorklet(config, jobId);
    if (!nextStatus) {
      throw new Error(`Populate worklet job ${jobId} became unavailable.`);
    }
    status = nextStatus;
  }

  return {
    jobId,
    status,
  };
}

export function kickPopulateLoopIfIdle(): boolean {
  if (populateLoopRunning.value) {
    return false;
  }

  const walletIds = queuedWalletIds();
  if (!walletIds.length) {
    return false;
  }

  let ctx: PopulateRuntimeContext;
  try {
    ctx = buildPopulateRuntimeContextFromStore();
  } catch (error: unknown) {
    populateRetryTick.value += 1;
    logPortfolioRuntimeError(error, {
      tag: 'kickPopulateLoopIfIdle',
      reason: 'buildContext',
    });
    return false;
  }

  const wallets = selectWalletsForPopulate({ctx, walletIds});
  if (!wallets.length) {
    populateRetryTick.value += 1;
    logPortfolioRuntimeError(new Error('No queued populate wallets available'), {
      tag: 'kickPopulateLoopIfIdle',
      reason: 'missingWalletContext',
    });
    return false;
  }

  const queue = loadQueue();
  const queueIngest = queue?.ingest;
  populateLoopRunning.value = true;
  void runOnPortfolioRuntimeAsync(
    getPortfolioPopulateRuntime(),
    runPopulateJobOnWorklet,
    buildPopulateWorkletConfig(),
    {
      cfg: {
        ...ctx.cfg,
        ...(queue?.cfg || {}),
      },
      wallets,
      ingest: {
        quoteCurrency: ctx.quoteCurrency,
        compressionEnabled: queueIngest?.compressionEnabled !== false,
        compressionAgeDays: queueIngest?.compressionAgeDays,
        chunkRows: PORTFOLIO_SNAPSHOT_CHUNK_ROW_BUDGET,
        snapshotDebugMode: 'none',
      },
      pageSize: Math.max(1, Math.trunc(Number(queue?.pageSize || 1000))),
      awaitTerminal: true,
    },
    ctx.signingContextsByWalletId,
  )
    .then(() => {
      populateProgressTick.value += 1;
    })
    .catch(logFireAndForgetRuntimeError('kickPopulateLoopIfIdle'))
    .finally(() => {
      populateLoopRunning.value = false;
    });
  return true;
}

export function stopPopulateLoopForTesting(): void {
  populateLoopRunning.value = false;
}
