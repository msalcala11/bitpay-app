import type {KvStore} from '../../core/kv/types';
import type {
  SnapshotChunkV2,
  SnapshotIndexV2,
  SnapshotWalletMetaV2,
} from '../../core/pnl/snapshotStore';
import {
  workletKvGetString,
  type PortfolioWorkletKvConfig,
} from '../../runtime/worklet/portfolioWorkletKv';

export type SnapshotKvKeyParts = Readonly<{
  walletId: string;
  chunkId: number | string;
}>;

export type PortfolioV2SnapshotKvReaderStore = Pick<KvStore, 'getString'>;

export type PortfolioV2SnapshotReader = Readonly<{
  loadMeta(walletId: string): Promise<SnapshotWalletMetaV2 | null>;
  loadIndex(walletId: string): Promise<SnapshotIndexV2 | null>;
  loadChunk(args: SnapshotKvKeyParts): Promise<SnapshotChunkV2 | null>;
}>;

export function getSnapshotMetaKey(walletId: string): string {
  'worklet';

  return `snap:meta:v2:${walletId}`;
}

export function getSnapshotIndexKey(walletId: string): string {
  'worklet';

  return `snap:index:v2:${walletId}`;
}

export function getSnapshotChunkKey(args: SnapshotKvKeyParts): string {
  'worklet';

  const chunkId = String(args.chunkId ?? '').trim();
  if (!chunkId) {
    throw new Error('Snapshot chunkId is required.');
  }
  return `snap:chunk:v2:${args.walletId}:${chunkId}`;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  'worklet';

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function normalizeSnapshotIndexRevision(
  index: SnapshotIndexV2,
): SnapshotIndexV2 {
  'worklet';

  const revision = Math.trunc(Number(index.revision));
  if (Number.isFinite(revision) && revision > 0) {
    return {
      ...index,
      revision,
    };
  }

  return {
    ...index,
    revision: 1,
  };
}

function toValidSnapshotMeta(
  walletId: string,
  raw: string | null | undefined,
): SnapshotWalletMetaV2 | null {
  'worklet';

  const meta = parseJson<SnapshotWalletMetaV2>(raw);
  if (!meta || meta.walletId !== walletId) {
    return null;
  }
  return meta;
}

function toValidSnapshotIndex(
  walletId: string,
  raw: string | null | undefined,
): SnapshotIndexV2 | null {
  'worklet';

  const index = parseJson<SnapshotIndexV2>(raw);
  if (!index || index.v !== 2 || index.walletId !== walletId) {
    return null;
  }
  return normalizeSnapshotIndexRevision(index);
}

function toValidSnapshotChunk(
  raw: string | null | undefined,
): SnapshotChunkV2 | null {
  'worklet';

  const chunk = parseJson<SnapshotChunkV2>(raw);
  if (!chunk || chunk.v !== 2 || !Array.isArray(chunk.rows)) {
    return null;
  }
  return chunk;
}

export async function readPortfolioV2SnapshotMeta(args: {
  store: PortfolioV2SnapshotKvReaderStore;
  walletId: string;
}): Promise<SnapshotWalletMetaV2 | null> {
  const walletId = String(args.walletId || '');
  return toValidSnapshotMeta(
    walletId,
    await args.store.getString(getSnapshotMetaKey(walletId)),
  );
}

export async function readPortfolioV2SnapshotIndex(args: {
  store: PortfolioV2SnapshotKvReaderStore;
  walletId: string;
}): Promise<SnapshotIndexV2 | null> {
  const walletId = String(args.walletId || '');
  return toValidSnapshotIndex(
    walletId,
    await args.store.getString(getSnapshotIndexKey(walletId)),
  );
}

export async function readPortfolioV2SnapshotChunk(args: {
  store: PortfolioV2SnapshotKvReaderStore;
  walletId: string;
  chunkId: number | string;
}): Promise<SnapshotChunkV2 | null> {
  return toValidSnapshotChunk(
    await args.store.getString(
      getSnapshotChunkKey({
        walletId: String(args.walletId || ''),
        chunkId: args.chunkId,
      }),
    ),
  );
}

export async function readPortfolioV2SnapshotMetaOnWorklet(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<SnapshotWalletMetaV2 | null> {
  'worklet';

  const normalizedWalletId = String(walletId || '');
  return toValidSnapshotMeta(
    normalizedWalletId,
    workletKvGetString(config, getSnapshotMetaKey(normalizedWalletId)),
  );
}

export async function readPortfolioV2SnapshotIndexOnWorklet(
  config: PortfolioWorkletKvConfig,
  walletId: string,
): Promise<SnapshotIndexV2 | null> {
  'worklet';

  const normalizedWalletId = String(walletId || '');
  return toValidSnapshotIndex(
    normalizedWalletId,
    workletKvGetString(config, getSnapshotIndexKey(normalizedWalletId)),
  );
}

export async function readPortfolioV2SnapshotChunkOnWorklet(
  config: PortfolioWorkletKvConfig,
  args: SnapshotKvKeyParts,
): Promise<SnapshotChunkV2 | null> {
  'worklet';

  return toValidSnapshotChunk(
    workletKvGetString(
      config,
      getSnapshotChunkKey({
        walletId: String(args.walletId || ''),
        chunkId: args.chunkId,
      }),
    ),
  );
}

export function createPortfolioV2SnapshotReader(
  store: PortfolioV2SnapshotKvReaderStore,
): PortfolioV2SnapshotReader {
  return {
    loadMeta: walletId => readPortfolioV2SnapshotMeta({store, walletId}),
    loadIndex: walletId => readPortfolioV2SnapshotIndex({store, walletId}),
    loadChunk: args =>
      readPortfolioV2SnapshotChunk({
        store,
        walletId: args.walletId,
        chunkId: args.chunkId,
      }),
  };
}
