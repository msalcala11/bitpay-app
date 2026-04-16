import type {Effect, RootState} from '..';
import type {Wallet} from '../wallet/wallet.models';
import {GetPrecision} from '../wallet/utils/currency';
import {
  getVisibleWalletsFromKeys,
  walletHasNonZeroLiveBalance,
} from '../../utils/portfolio/assets';
import {
  PortfolioPopulateService,
  getPortfolioPopulateDecisionsForWallets,
} from '../../portfolio/service';
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

const requestRuntimePopulateCancel = (): void => {
  void getPortfolioRuntimeClient().cancelPopulateJob({}).catch(() => undefined);
};

const waitForRuntimePopulateToStop = async (args?: {
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> => {
  const timeoutMs =
    typeof args?.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
      ? Math.max(0, Math.floor(args.timeoutMs))
      : 5000;
  const pollMs =
    typeof args?.pollMs === 'number' && Number.isFinite(args.pollMs)
      ? Math.max(50, Math.floor(args.pollMs))
      : 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const status = await getPortfolioRuntimeClient().getPopulateJobStatus({});
      if (!status?.inProgress) {
        return;
      }
    } catch {
      return;
    }

    await delay(pollMs);
  }
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
    .filter(isMainnetLikeWallet)
    .filter(walletHasNonZeroLiveBalance);
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

export const cancelPopulatePortfolioWithRuntime = (): Effect<void> => (
  dispatch,
  getState,
) => {
  cancelActiveRuntimePopulateIfNeeded(dispatch, getState());
};

export const clearPortfolioWithRuntime = (payload?: {
  populateDisabled?: boolean;
}): Effect<Promise<void>> => async (dispatch, getState) => {
  cancelActiveRuntimePopulateIfNeeded(dispatch, getState());
  await waitForRuntimePopulateToStop();

  try {
    await getPortfolioRuntimeClient().clearAllStorage();
  } catch (error: unknown) {
    logManager.warn(
      '[portfolio] Failed clearing runtime portfolio storage: ' +
        toErrorMessage(error),
    );
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
  });
  activeRuntimePopulateService = service;

  try {
    let lastErrorCount = 0;
    let latestErrors: Array<{walletId: string; message: string}> = [];
    const result = await service.populateWallets({
      wallets: storedWallets,
      onProgress: progress => {
        latestErrors = Array.isArray(progress.errors) ? progress.errors : [];
        const nextErrors = progress.errors.slice(lastErrorCount);
        lastErrorCount = progress.errors.length;

        dispatch(
          updatePopulateProgress({
            currentWalletId: progress.currentWalletId,
            walletsTotal: progress.walletsTotal,
            walletsCompleted: progress.walletsCompleted,
            txRequestsMade: progress.txRequestsMade,
            txsProcessed: progress.txsProcessed,
            walletStatusByIdUpdates: progress.walletStatusById,
            errorsToAdd: nextErrors.length ? nextErrors : undefined,
          }),
        );
      },
    });

    if (result.cancelled) {
      dispatch(cancelPopulatePortfolio());
      return;
    }

    dispatch(
      finishPopulatePortfolio({
        finishedAt: result.finishedAt,
        reason: buildPopulateStopReason({
          errors: latestErrors,
          requestedWalletCount: storedWallets.length,
          completedWalletCount: Array.isArray(result.results)
            ? result.results.length
            : 0,
        }),
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
