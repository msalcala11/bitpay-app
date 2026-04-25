import {getPortfolioMmkvStorageOnRN} from '../adapters/rn/workletMmkvBridge';
import {CANONICAL_RATE_QUOTE, MANIFEST_KEY} from './constants';
import {writePortfolioMmkvString} from './kvStore';
import {logPortfolioRuntimeError} from './logPortfolioRuntimeError';
import type {PortfolioManifestV1} from './model';

export function emptyManifest(now = Date.now()): PortfolioManifestV1 {
  return {
    schemaVersion: 1,
    canonicalRateQuoteCurrency: CANONICAL_RATE_QUOTE,
    populatedWalletIds: [],
    invalidHistoryWalletIds: [],
    populateOrderWalletIds: [],
    populateOrderAssetGroupIds: [],
    orderRevision: 0,
    updatedAt: now,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function validateManifest(value: unknown): PortfolioManifestV1 | null {
  const candidate = value as Partial<PortfolioManifestV1> | undefined;
  if (
    !candidate ||
    candidate.schemaVersion !== 1 ||
    candidate.canonicalRateQuoteCurrency !== CANONICAL_RATE_QUOTE ||
    !isStringArray(candidate.populatedWalletIds) ||
    !isStringArray(candidate.invalidHistoryWalletIds) ||
    !isStringArray(candidate.populateOrderWalletIds) ||
    !isStringArray(candidate.populateOrderAssetGroupIds) ||
    typeof candidate.orderRevision !== 'number' ||
    typeof candidate.updatedAt !== 'number'
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    canonicalRateQuoteCurrency: CANONICAL_RATE_QUOTE,
    populatedWalletIds: candidate.populatedWalletIds.slice(),
    invalidHistoryWalletIds: candidate.invalidHistoryWalletIds.slice(),
    populateOrderWalletIds: candidate.populateOrderWalletIds.slice(),
    populateOrderAssetGroupIds: candidate.populateOrderAssetGroupIds.slice(),
    orderRevision: candidate.orderRevision,
    initialPopulateStartedAt:
      typeof candidate.initialPopulateStartedAt === 'number'
        ? candidate.initialPopulateStartedAt
        : undefined,
    initialPopulateCompletedAt:
      typeof candidate.initialPopulateCompletedAt === 'number'
        ? candidate.initialPopulateCompletedAt
        : undefined,
    updatedAt: candidate.updatedAt,
  };
}

export function loadManifest(): PortfolioManifestV1 | null {
  const raw = getPortfolioMmkvStorageOnRN().getString(MANIFEST_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = validateManifest(parsed);
    if (!validated) {
      logPortfolioRuntimeError(new Error('Invalid portfolio manifest'), {
        tag: 'loadManifest',
        reason: 'invalidSchema',
      });
      return null;
    }
    return validated;
  } catch (err) {
    logPortfolioRuntimeError(err, {
      tag: 'loadManifest',
      reason: 'parseError',
    });
    return null;
  }
}

export function saveManifest(manifest: PortfolioManifestV1): void {
  writePortfolioMmkvString({
    key: MANIFEST_KEY,
    value: JSON.stringify(manifest),
    reason: 'manifest',
  });
}
