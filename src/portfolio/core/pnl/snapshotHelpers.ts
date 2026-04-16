import type {WalletCredentials} from '../types';
import {formatBigIntDecimal, getAtomicDecimals, makeAtomicToUnitNumberConverter, parseAtomicToBigint} from '../format';
import type {BalanceSnapshotComputed, BalanceSnapshotStored} from './types';

export type BalanceSnapshotComputer = (
  s: BalanceSnapshotStored,
  prevSnapshot?: BalanceSnapshotStored | null,
) => BalanceSnapshotComputed;

export function extractTxIdFromSnapshotId(snapshotId: string): string | null {
  const parts = String(snapshotId || '').split(':');
  if (parts.length < 3) return null;
  if (parts[0] !== 'tx') return null;
  const txid = parts.slice(2).join(':');
  return txid ? txid : null;
}

export function makeBalanceSnapshotComputer(credentials: WalletCredentials): BalanceSnapshotComputer {
  const decimals = getAtomicDecimals(credentials);
  const atomicToUnitNumber = makeAtomicToUnitNumberConverter(decimals);
  const formatAtomicAmount = (atomic: bigint): string => formatBigIntDecimal(atomic, decimals, decimals);

  return (s, prevSnapshot) => {
    const atomic = parseAtomicToBigint(s.cryptoBalance);
    const unitsHeld = atomicToUnitNumber(atomic);

    const prevAtomic = prevSnapshot ? parseAtomicToBigint(prevSnapshot.cryptoBalance) : 0n;
    const balanceDeltaAtomic = (atomic - prevAtomic).toString();

    const formattedCryptoBalance = formatAtomicAmount(atomic);
    const markRate = s.markRate;
    const fiatBalance = Number.isFinite(markRate) ? unitsHeld * markRate : NaN;
    const avgCostFiatPerUnit = unitsHeld > 0 ? s.remainingCostBasisFiat / unitsHeld : 0;
    const unrealizedPnlFiat = fiatBalance - s.remainingCostBasisFiat;

    return {
      ...s,
      balanceDeltaAtomic,
      avgCostFiatPerUnit,
      formattedCryptoBalance,
      fiatBalance,
      unrealizedPnlFiat,
    };
  };
}

export function computeBalanceSnapshotComputed(
  s: BalanceSnapshotStored,
  credentials: WalletCredentials,
  prevSnapshot?: BalanceSnapshotStored | null,
): BalanceSnapshotComputed {
  return makeBalanceSnapshotComputer(credentials)(s, prevSnapshot);
}
