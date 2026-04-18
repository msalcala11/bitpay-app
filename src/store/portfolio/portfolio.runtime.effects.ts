import type {Effect, RootState} from '..';
import type {Wallet} from '../wallet/wallet.models';
import {GetPrecision} from '../wallet/utils/currency';
import {
  getVisibleWalletsFromKeys,
} from '../../utils/portfolio/assets';
import {
  PortfolioPopulateService,
  getPortfolioPopulateDecisionsForWallets,
} from '../../portfolio/service';
import type {SnapshotPersistDebugMode} from '../../portfolio/core/pnl/snapshotStore';
import {getPortfolioRuntimeClient} from '../../portfolio/runtime/portfolioRuntime';
import {
  isPortfolioRuntimeEligibleWallet,
  toPortfolioStoredWallet,
} from '../../portfolio/adapters/rn/walletMappers';
import {logManager} from '../../managers/LogManager';
import {
  cancelPopulatePortfolio,
  clearPortfolio,
  clearWalletPortfolioState,
  failPopulatePortfolio,
  finishPopulatePortfolio,
  setSnapshotBalanceMismatchesByWalletIdUpdates,
  startPopulatePortfolio,
  updatePopulateProgress,
} from './portfolio.actions';

let activeRuntimePopulateService: PortfolioPopulateService | undefined;

const resolveQuoteCurrency = (
  ...candidates: Array<string | undefined>
): string => {
  const candidate = candidates.find(v => typeof v === 'string' && v.length);
  return (candidate || 'USD').toUpperCase();
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatPopulateWalletError = (error: {
  walletId?: string;
  message?: string;
}): string => {
  const walletId = String(error.walletId || '').trim();
  const message = String(error.message || '').trim() || 'Unknown wallet error';
  return walletId ? `${walletId}: ${message}` : message;
};

const buildPopulateStopReason = (args: {
  errors: Array<{walletId: string; message: string}>;
  requestedWalletCount: number;
  completedWalletCount: number;
}): string => {
  if (args.errors.length) {
    const lastError = formatPopulateWalletError(
      args.errors[args.errors.length - 1],
    );
    if (args.errors.length === 1) {
      return `completed with wallet error: ${lastError}`;
    }

    return `completed with ${args.errors.length} wallet errors; last: ${lastError}`;
  }

  if (
    args.requestedWalletCount > 0 &&
    args.completedWalletCount < args.requestedWalletCount
  ) {
    return `completed after ${args.completedWalletCount}/${args.requestedWalletCount} wallets`;
  }

  return 'completed';
};

const normalizeWalletIds = (walletIds?: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const walletId of walletIds || []) {
    if (typeof walletId !== 'string' || !walletId || seen.has(walletId)) {
      continue;
    }
    seen.add(walletId);
    result.push(walletId);
  }

  return result;
};

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)), undefined);
  });

const RUNTIME_MUTATION_WAIT_TIMEOUT_MS = 15000;
const RUNTIME_MUTATION_POLL_MS = 100;
const ACTIVE_RUNTIME_POPULATE_MUTATION_ERROR_PATTERN =
  /background populate job is running/i;

const requestRuntimePopulateCancel = (): void => {
  void getPortfolioRuntimeClient().cancelPopulateJob({}).catch(() => undefined);
};

const waitForRuntimePopulateToStop = async (args?: {
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> => {
  const timeoutMs =
    typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
      ? Math.max(0, Math.floor(args.timeoutMs))
      : RUNTIME_MUTATION_WAIT_TIMEOUT_MS;
  const pollMs =
    typeof args?.pollMs === 'number' && Number.isFinite(args.pollMs)
      ? Math.max(50, Math.floor(args.pollMs))
      : RUNTIME_MUTATION_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const client = getPortfolioRuntimeClient();

  while (Date.now() <= deadline) {
    try {
      const status = await client.getPopulateJobStatus({});
      if (!status?.inProgress) {
        return true;
      }
    } catch {
      // Keep polling until timeout; transient runtime errors during shutdown
      // should not make us assume the populate job has fully stopped.
    }

    await delay(pollMs);
  }

  return false;
};

const isActiveRuntimePopulateMutationError = (error: unknown): boolean =>
  ACTIVE_RUNTIME_POPULATE_MUTATION_ERROR_PATTERN.test(toErrorMessage(error));

const clearRuntimeStorageAfterPopulateStops = async (
  clear: () => Promise<void>,
): Promise<void> => {
  const deadline = Date.now() + RUNTIME_MUTATION_WAIT_TIMEOUT_MS;

  await waitForRuntimePopulateToStop({
    timeoutMs: RUNTIME_MUTATION_WAIT_TIMEOUT_MS,
    pollMs: RUNTIME_MUTATION_POLL_MS,
  });

  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await clear();
      return;
    } catch (error: unknown) {
      lastError = error;
      if (!isActiveRuntimePopulateMutationError(error)) {
        throw error;
      }
    }

    requestRuntimePopulateCancel();

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(RUNTIME_MUTATION_POLL_MS, remainingMs));
  }

  throw (
    lastError ??
    new Error(
      'Timed out clearing runtime portfolio storage while a background populate job was stopping.',
    )
  );
};

const cancelActiveRuntimePopulateIfNeeded = (
  dispatch: any,
  state?: RootState,
) => {
  if (!state?.PORTFOLIO?.populateStatus?.inProgress) {
    return;
  }

  activeRuntimePopulateService?.cancel();
  requestRuntimePopulateCancel();
  activeRuntimePopulateService = undefined;
  dispatch(cancelPopulatePortfolio());
};

const isPortfolioEnabled = (state: RootState): boolean =>
  state.APP?.showPortfolioValue !== false;

const isPortfolioPopulateDisabled = (state: RootState): boolean =>
  state.PORTFOLIO?.populateDisabled === true;

const isMainnetLikeWallet = (wallet: Wallet): boolean => {
  const network = String(wallet?.network || '').trim().toLowerCase();
  return network === 'livenet' || network === 'mainnet';
};

const getVisibleMainnetWalletsFromState = (state: RootState): Wallet[] => {
  const keys = state.WALLET?.keys || {};
  const homeCarouselConfig = state.APP?.homeCarouselConfig;

  return getVisibleWalletsFromKeys(keys, homeCarouselConfig).filter(
    isMainnetLikeWallet,
  );
};

const getAllMainnetWalletIdsFromState = (state: RootState): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();

  Object.values(state.WALLET?.keys || {}).forEach((key: any) => {
    const wallets = Array.isArray(key?.wallets) ? key.wallets : [];
    wallets.forEach((wallet: Wallet) => {
      if (!isMainnetLikeWallet(wallet)) {
        return;
      }

      const walletId = String(wallet?.id || '').trim();
      if (!walletId || seen.has(walletId)) {
        return;
      }

      seen.add(walletId);
      out.push(walletId);
    });
  });

  return out;
};

const resolvePopulateWallets = (args: {
  state: RootState;
  wallets?: Wallet[];
  walletIds?: string[];
}): Wallet[] => {
  const providedWallets = Array.isArray(args.wallets)
    ? args.wallets
    : getVisibleMainnetWalletsFromState(args.state);

  const walletIdsFilter = Array.isArray(args.walletIds)
    ? new Set(args.walletIds)
    : undefined;

  return providedWallets
    .filter(wallet => !walletIdsFilter || walletIdsFilter.has(wallet.id))
    .filter(isMainnetLikeWallet);
};

const toUnitDecimals = (dispatch: any, wallet: Wallet): number => {
  const precision =
    dispatch(
      GetPrecision(
        wallet.currencyAbbreviation,
        wallet.chain,
        wallet.tokenAddress,
      ),
    ) || undefined;
  return precision?.unitDecimals || 0;
};

const buildSnapshotMismatchClearUpdatesFromPopulateResult = (args: {
  status?: {
    walletStatusById?: {[walletId: string]: 'in_progress' | 'done' | 'error' | undefined};
  };
  runResults?: Array<{
    walletId: string;
    cancelled?: boolean;
  }>;
}): {[walletId: string]: undefined} => {
  const out: {[walletId: string]: undefined} = {};

  Object.entries(args.status?.walletStatusById || {}).forEach(
    ([walletId, walletStatus]) => {
      if (walletStatus !== 'done' || !walletId) {
        return;
      }
      out[walletId] = undefined;
    },
  );

  (args.runResults || []).forEach(runResult => {
    const walletId = String(runResult?.walletId || '').trim();
    if (!walletId || runResult?.cancelled) {
      return;
    }
    out[walletId] = undefined;
  });

  return out;
};

const isRuntimeStorageFullyCleared = async (args: {
  client: ReturnType<typeof getPortfolioRuntimeClient>;
  walletIds: string[];
}): Promise<boolean> => {
  const {client, walletIds} = args;
  const stats = await client.kvStats();
  const totalKeys = Number(stats?.totalKeys ?? 0);
  if (Number.isFinite(totalKeys) && totalKeys > 0) {
    return false;
  }

  const rateEntries = await client.listRates({});
  if (Array.isArray(rateEntries) && rateEntries.length) {
    return false;
  }

  if (walletIds.length) {
    const indexes = await Promise.all(
      walletIds.map(async walletId => {
        try {
          return await client.getSnapshotIndex({walletId});
        } catch {
          return null;
        }
      }),
    );

    if (indexes.some(index => !!index)) {
      return false;
    }
  }

  return !Number.isFinite(totalKeys) || totalKeys <= 0;
};

const waitForRuntimeStorageToClear = async (args: {
  client: ReturnType<typeof getPortfolioRuntimeClient>;
  walletIds: string[];
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> => {
  const timeoutMs =
    typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
      ? Math.max(0, Math.floor(args.timeoutMs))
      : RUNTIME_MUTATION_WAIT_TIMEOUT_MS;
  const pollMs =
    typeof args.pollMs === 'number' && Number.isFinite(args.pollMs)
      ? Math.max(50, Math.floor(args.pollMs))
      : RUNTIME_MUTATION_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      if (
        await isRuntimeStorageFullyCleared({
          client: args.client,
          walletIds: args.walletIds,
        })
      ) {
        return;
      }
    } catch (error: unknown) {
      lastError = error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await delay(Math.min(pollMs, remainingMs));
  }

  throw (
    lastError ??
    new Error(
      'Timed out waiting for runtime portfolio storage to fully clear.',
    )
  );
};

export const cancelPopulatePortfolioWithRuntime = (): Effect<void> => (
  dispatch,
  getState,
) => {
  cancelActiveRuntimePopulateIfNeeded(dispatch, getState());
};

export const clearPortfolioWithRuntime = (payload?: {
  populateDisabled?: boolean;
}): Effect<Promise<void>> => async (dispatch, getState) => {
  const state = getState();
  cancelActiveRuntimePopulateIfNeeded(dispatch, state);
  const client = getPortfolioRuntimeClient();
  const walletIds = getAllMainnetWalletIdsFromState(state);

  try {
    await clearRuntimeStorageAfterPopulateStops(() => client.clearAllStorage());
    await waitForRuntimeStorageToClear({
      client,
      walletIds,
    });
  } catch (error: unknown) {
    logManager.warn(
      '[portfolio] Failed clearing runtime portfolio storage: ' +
        toErrorMessage(error),
    );
    throw error;
  }

  dispatch(clearPortfolio(payload));
};

export const clearWalletPortfolioDataWithRuntime = (args: {
  walletIds: string[];
}): Effect<Promise<void>> => async (dispatch, getState) => {
  const walletIds = normalizeWalletIds(args.walletIds);
  if (!walletIds.length) {
    return;
  }

  cancelActiveRuntimePopulateIfNeeded(dispatch, getState());
  await waitForRuntimePopulateToStop();

  const client = getPortfolioRuntimeClient();
  const results = await Promise.allSettled(
    walletIds.map(walletId => client.clearWallet({walletId})),
  );

  results.forEach((result, index) => {
    if (result.status !== 'rejected') {
      return;
    }

    logManager.warn(
      `[portfolio] Failed clearing runtime wallet storage for ${walletIds[index]}: ${toErrorMessage(
        result.reason,
      )}`,
    );
  });

  dispatch(clearWalletPortfolioState({walletIds}));
};

export const maybePopulatePortfolioForWalletsWithRuntime = (args: {
  wallets: Wallet[];
  quoteCurrency?: string;
}): Effect<Promise<void>> => async (dispatch, getState) => {
  const state = getState();
  if (!isPortfolioEnabled(state) || isPortfolioPopulateDisabled(state)) {
    return;
  }
  if (state.PORTFOLIO?.populateStatus?.inProgress) {
    return;
  }

  const runtimeEligibleWallets = (Array.isArray(args.wallets)
    ? args.wallets
    : []
  ).filter(isPortfolioRuntimeEligibleWallet);
  if (!runtimeEligibleWallets.length) {
    return;
  }

  const client = getPortfolioRuntimeClient();
  const decisions = await getPortfolioPopulateDecisionsForWallets({
    client,
    wallets: runtimeEligibleWallets,
    getUnitDecimals: wallet => toUnitDecimals(dispatch, wallet),
  });

  dispatch(
    setSnapshotBalanceMismatchesByWalletIdUpdates(
      decisions.mismatchByWalletId as any,
    ),
  );

  if (!decisions.walletIdsToPopulate.length) {
    return;
  }

  const walletsToPopulate = runtimeEligibleWallets.filter(wallet =>
    decisions.walletIdsToPopulate.includes(wallet.id),
  );

  await dispatch(
    populatePortfolioWithRuntime({
      wallets: walletsToPopulate,
      quoteCurrency: args.quoteCurrency,
    }),
  );
};

export const populatePortfolioWithRuntime = (args?: {
  wallets?: Wallet[];
  walletIds?: string[];
  quoteCurrency?: string;
  snapshotDebugMode?: SnapshotPersistDebugMode;
}): Effect<Promise<void>> => async (dispatch, getState) => {
  const state = getState();
  if (!isPortfolioEnabled(state) || isPortfolioPopulateDisabled(state)) {
    return;
  }
  if (state.PORTFOLIO?.populateStatus?.inProgress) {
    return;
  }

  const quoteCurrency = resolveQuoteCurrency(
    args?.quoteCurrency,
    state.APP?.defaultAltCurrency?.isoCode,
  );

  const walletsToPopulate = resolvePopulateWallets({
    state,
    wallets: args?.wallets,
    walletIds: args?.walletIds,
  });

  const storedWallets = walletsToPopulate
    .filter(isPortfolioRuntimeEligibleWallet)
    .map(wallet =>
      toPortfolioStoredWallet({
        wallet,
        unitDecimals: toUnitDecimals(dispatch, wallet),
      }),
    );

  if (!storedWallets.length) {
    return;
  }

  dispatch(startPopulatePortfolio({quoteCurrency}));

  const service = new PortfolioPopulateService({
    client: getPortfolioRuntimeClient(),
    ingestConfig: args?.snapshotDebugMode
      ? {snapshotDebugMode: args.snapshotDebugMode}
      : undefined,
  });
  activeRuntimePopulateService = service;

  try {
    const result = await service.populateWallets({
      wallets: storedWallets,
    });
    const finalStatus = result.status;
    const mismatchClearUpdates =
      buildSnapshotMismatchClearUpdatesFromPopulateResult({
        status: finalStatus,
        runResults: result.results,
      });

    dispatch(
      updatePopulateProgress({
        currentWalletId: finalStatus.currentWalletId,
        walletsTotal: finalStatus.walletsTotal,
        walletsCompleted: finalStatus.walletsCompleted,
        txRequestsMade: finalStatus.txRequestsMade,
        txsProcessed: finalStatus.txsProcessed,
        walletStatusByIdUpdates: finalStatus.walletStatusById,
        errorsToAdd: finalStatus.errors.length ? finalStatus.errors : undefined,
      }),
    );

    if (Object.keys(mismatchClearUpdates).length) {
      dispatch(
        setSnapshotBalanceMismatchesByWalletIdUpdates(mismatchClearUpdates),
      );
    }

    if (result.cancelled) {
      dispatch(cancelPopulatePortfolio());
      return;
    }

    dispatch(
      finishPopulatePortfolio({
        finishedAt: result.finishedAt,
        reason: buildPopulateStopReason({
          errors: finalStatus.errors,
          requestedWalletCount: storedWallets.length,
          completedWalletCount: finalStatus.walletsCompleted,
        }),
        quoteCurrency,
      }),
    );
  } catch (error: unknown) {
    dispatch(
      failPopulatePortfolio({
        error: toErrorMessage(error),
      }),
    );
  } finally {
    if (activeRuntimePopulateService === service) {
      activeRuntimePopulateService = undefined;
    }
  }
};
