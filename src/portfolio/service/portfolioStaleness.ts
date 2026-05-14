import type {BalanceSnapshotStored} from '../core/pnl/types';
import type {SnapshotIndexV2} from '../core/pnl/snapshotStore';
import {isSnapshotInvalidHistoryMarkerActive} from '../core/pnl/invalidHistory';
import type {PortfolioRuntimeClient} from '../runtime/portfolioClient';
import type {Wallet} from '../../store/wallet/wallet.models';
import {atomicToUnitString} from '../../utils/helper-methods';
import {getWalletLiveAtomicBalance} from '../../utils/portfolio/assets';
import {normalizeWalletUnitDecimals} from '../core/format';

export type PortfolioSnapshotBalanceMismatch = {
  walletId: string;
  computedAtomic: string;
  currentAtomic: string;
  deltaAtomic: string;
  computedUnitsHeld: string;
  currentWalletBalance: string;
  delta: string;
};

export type PortfolioPopulateDecisionReason =
  | 'missing_index'
  | 'missing_snapshot'
  | 'invalid_snapshot_balance'
  | 'balance_mismatch'
  | 'unchanged_balance_mismatch'
  | 'invalid_decimals'
  | 'invalid_history'
  | 'up_to_date';

export type PortfolioInvalidDecimalsMarker = {
  walletId: string;
  reason: 'invalid_decimals';
  message: string;
};

export type PortfolioUnitDecimalsResolution =
  | {ok: true; unitDecimals: number}
  | {ok: false; reason: 'invalid_decimals'; message: string};

export type PortfolioPopulateDecision = {
  walletId: string;
  shouldPopulate: boolean;
  reason: PortfolioPopulateDecisionReason;
  index: SnapshotIndexV2 | null;
  latestSnapshot: BalanceSnapshotStored | null;
  mismatch?: PortfolioSnapshotBalanceMismatch;
  invalidDecimals?: PortfolioInvalidDecimalsMarker;
};

export const getPortfolioInvalidDecimalsMessage = (walletId: string): string =>
  `Wallet ${walletId || 'unknown'} has unresolved token decimals.`;

function buildBalanceMismatch(args: {
  walletId: string;
  computedAtomic: bigint;
  actualAtomic: bigint;
  unitDecimals: number;
}): PortfolioSnapshotBalanceMismatch | undefined {
  if (args.computedAtomic === args.actualAtomic) {
    return undefined;
  }

  return {
    walletId: args.walletId,
    computedAtomic: args.computedAtomic.toString(),
    currentAtomic: args.actualAtomic.toString(),
    deltaAtomic: (args.computedAtomic - args.actualAtomic).toString(),
    computedUnitsHeld: atomicToUnitString(
      args.computedAtomic,
      args.unitDecimals,
    ),
    currentWalletBalance: atomicToUnitString(
      args.actualAtomic,
      args.unitDecimals,
    ),
    delta: atomicToUnitString(
      args.computedAtomic - args.actualAtomic,
      args.unitDecimals,
    ),
  };
}

function parseStoredAtomicBalance(value: unknown): bigint | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  return BigInt(normalized);
}

function normalizeUnitDecimalsResolution(
  value: PortfolioUnitDecimalsResolution | number | undefined,
  walletId: string,
): PortfolioUnitDecimalsResolution {
  const directUnitDecimals =
    typeof value === 'number' ? normalizeWalletUnitDecimals(value) : undefined;
  if (typeof directUnitDecimals === 'number') {
    return {ok: true, unitDecimals: directUnitDecimals};
  }

  if (value && typeof value === 'object' && value.ok === true) {
    const unitDecimals =
      typeof value.unitDecimals === 'number'
        ? normalizeWalletUnitDecimals(value.unitDecimals)
        : undefined;
    if (typeof unitDecimals === 'number') {
      return {ok: true, unitDecimals};
    }
  }

  if (value && typeof value === 'object' && value.ok === false) {
    return value;
  }

  return {
    ok: false,
    reason: 'invalid_decimals',
    message: getPortfolioInvalidDecimalsMessage(walletId),
  };
}

export async function getPortfolioPopulateDecisionForWallet(args: {
  client: PortfolioRuntimeClient;
  wallet: Wallet;
  unitDecimals: number;
  previousMismatch?: PortfolioSnapshotBalanceMismatch;
}): Promise<PortfolioPopulateDecision> {
  const walletId = String(args.wallet?.id || '').trim();
  const invalidHistory = await args.client.getInvalidHistory({walletId});
  if (isSnapshotInvalidHistoryMarkerActive(invalidHistory)) {
    return {
      walletId,
      shouldPopulate: false,
      reason: 'invalid_history',
      index: null,
      latestSnapshot: null,
    };
  }

  const index = await args.client.getSnapshotIndex({walletId});
  if (!index) {
    return {
      walletId,
      shouldPopulate: true,
      reason: 'missing_index',
      index: null,
      latestSnapshot: null,
    };
  }

  const latestSnapshot = await args.client.getLatestSnapshot({walletId});
  if (!latestSnapshot) {
    return {
      walletId,
      shouldPopulate: true,
      reason: 'missing_snapshot',
      index,
      latestSnapshot: null,
    };
  }

  const snapshotAtomic = parseStoredAtomicBalance(latestSnapshot.cryptoBalance);
  if (snapshotAtomic === null) {
    return {
      walletId,
      shouldPopulate: true,
      reason: 'invalid_snapshot_balance',
      index,
      latestSnapshot,
    };
  }

  const liveAtomic = getWalletLiveAtomicBalance({
    wallet: args.wallet,
    unitDecimals: args.unitDecimals,
  });
  const mismatch = buildBalanceMismatch({
    walletId,
    computedAtomic: snapshotAtomic,
    actualAtomic: liveAtomic,
    unitDecimals: args.unitDecimals,
  });

  if (mismatch) {
    if (args.previousMismatch?.deltaAtomic === mismatch.deltaAtomic) {
      return {
        walletId,
        shouldPopulate: false,
        reason: 'unchanged_balance_mismatch',
        index,
        latestSnapshot,
        mismatch,
      };
    }

    return {
      walletId,
      shouldPopulate: true,
      reason: 'balance_mismatch',
      index,
      latestSnapshot,
      mismatch,
    };
  }

  return {
    walletId,
    shouldPopulate: false,
    reason: 'up_to_date',
    index,
    latestSnapshot,
  };
}

export async function getPortfolioPopulateDecisionsForWallets(args: {
  client: PortfolioRuntimeClient;
  wallets: Wallet[];
  getUnitDecimals: (
    wallet: Wallet,
  ) =>
    | Promise<PortfolioUnitDecimalsResolution | number | undefined>
    | PortfolioUnitDecimalsResolution
    | number
    | undefined;
  previousMismatchByWalletId?: {
    [walletId: string]: PortfolioSnapshotBalanceMismatch | undefined;
  };
}): Promise<{
  decisions: PortfolioPopulateDecision[];
  walletIdsToPopulate: string[];
  mismatchByWalletId: {
    [walletId: string]: PortfolioSnapshotBalanceMismatch | undefined;
  };
  invalidDecimalsByWalletId: {
    [walletId: string]: PortfolioInvalidDecimalsMarker | undefined;
  };
}> {
  const decisions: PortfolioPopulateDecision[] = [];
  const walletIdsToPopulate: string[] = [];
  const mismatchByWalletId: {
    [walletId: string]: PortfolioSnapshotBalanceMismatch | undefined;
  } = {};
  const invalidDecimalsByWalletId: {
    [walletId: string]: PortfolioInvalidDecimalsMarker | undefined;
  } = {};

  for (const wallet of args.wallets || []) {
    const walletId = String(wallet?.id || '').trim();
    const decimalsResolution = normalizeUnitDecimalsResolution(
      await args.getUnitDecimals(wallet),
      walletId,
    );
    if (!decimalsResolution.ok) {
      const invalidDecimals: PortfolioInvalidDecimalsMarker = {
        walletId,
        reason: 'invalid_decimals',
        message: decimalsResolution.message,
      };
      const decision: PortfolioPopulateDecision = {
        walletId,
        shouldPopulate: false,
        reason: 'invalid_decimals',
        index: null,
        latestSnapshot: null,
        invalidDecimals,
      };
      decisions.push(decision);
      mismatchByWalletId[walletId] = undefined;
      invalidDecimalsByWalletId[walletId] = invalidDecimals;
      continue;
    }

    const decision = await getPortfolioPopulateDecisionForWallet({
      client: args.client,
      wallet,
      unitDecimals: decimalsResolution.unitDecimals,
      previousMismatch: args.previousMismatchByWalletId?.[walletId],
    });
    decisions.push(decision);
    mismatchByWalletId[decision.walletId] = decision.mismatch;
    invalidDecimalsByWalletId[decision.walletId] = undefined;
    if (decision.shouldPopulate) {
      walletIdsToPopulate.push(decision.walletId);
    }
  }

  return {
    decisions,
    walletIdsToPopulate,
    mismatchByWalletId,
    invalidDecimalsByWalletId,
  };
}
