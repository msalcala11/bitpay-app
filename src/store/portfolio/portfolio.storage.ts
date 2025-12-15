import {MMKV} from 'react-native-mmkv';

export type PortfolioTx = {
  txid: string;
  time: number;
  action?: string;
  amount?: number;
  fees?: number;
  fee?: number;
  coin?: string;
  chain?: string;
  tokenAddress?: string;
  effects?: any[];
};

export type WalletTxMeta = {
  txCount: number;
  chunkCount: number;
};

const kv = new MMKV();

const TX_CHUNK_SIZE = 500;

const txMetaKey = (walletId: string) => `portfolio:txMeta:${walletId}`;
const txChunkKey = (walletId: string, chunkIndex: number) =>
  `portfolio:txs:${walletId}:${chunkIndex}`;

export const readWalletTxMeta = (walletId: string): WalletTxMeta => {
  const raw = kv.getString(txMetaKey(walletId));
  if (!raw) {
    return {txCount: 0, chunkCount: 0};
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      txCount: Number(parsed?.txCount ?? 0),
      chunkCount: Number(parsed?.chunkCount ?? 0),
    };
  } catch (_) {
    return {txCount: 0, chunkCount: 0};
  }
};

const writeWalletTxMeta = (walletId: string, meta: WalletTxMeta) => {
  kv.set(txMetaKey(walletId), JSON.stringify(meta));
};

export const resetWalletTxs = (walletId: string) => {
  const meta = readWalletTxMeta(walletId);
  for (let i = 0; i < meta.chunkCount; i++) {
    kv.delete(txChunkKey(walletId, i));
  }
  writeWalletTxMeta(walletId, {txCount: 0, chunkCount: 0});
};

export const appendWalletTxs = (
  walletId: string,
  txs: PortfolioTx[],
): WalletTxMeta => {
  if (!txs.length) {
    return readWalletTxMeta(walletId);
  }

  let meta = readWalletTxMeta(walletId);
  let remaining = txs;

  while (remaining.length) {
    // Determine which chunk to write into and how many items it already has.
    const lastChunkIndex = meta.chunkCount > 0 ? meta.chunkCount - 1 : 0;
    const lastChunkKey = txChunkKey(walletId, lastChunkIndex);

    let existing: PortfolioTx[] = [];
    if (meta.chunkCount > 0) {
      const existingRaw = kv.getString(lastChunkKey);
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw);
          if (Array.isArray(parsed)) {
            existing = parsed;
          }
        } catch (_) {}
      }
    }

    const canAppendToLast = meta.chunkCount > 0 && existing.length < TX_CHUNK_SIZE;
    const targetIndex = canAppendToLast ? lastChunkIndex : meta.chunkCount;
    const targetKey = txChunkKey(walletId, targetIndex);

    const base = canAppendToLast ? existing : [];
    const capacity = TX_CHUNK_SIZE - base.length;
    const toWrite = remaining.slice(0, capacity);
    const updated = base.concat(toWrite);

    kv.set(targetKey, JSON.stringify(updated));

    meta = {
      txCount: meta.txCount + toWrite.length,
      chunkCount: Math.max(meta.chunkCount, targetIndex + 1),
    };
    writeWalletTxMeta(walletId, meta);

    remaining = remaining.slice(toWrite.length);
  }

  return meta;
};

export const readWalletTxs = (walletId: string): PortfolioTx[] => {
  const meta = readWalletTxMeta(walletId);
  const all: PortfolioTx[] = [];
  for (let i = 0; i < meta.chunkCount; i++) {
    const raw = kv.getString(txChunkKey(walletId, i));
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        all.push(...parsed);
      }
    } catch (_) {}
  }
  return all;
};

const rateMapKey = (fiatCode: string, symbol: string) =>
  `portfolio:rateMap:${fiatCode.toUpperCase()}:${symbol.toLowerCase()}`;

export const readRateMap = (
  fiatCode: string,
  symbol: string,
): Record<string, number> => {
  const raw = kv.getString(rateMapKey(fiatCode, symbol));
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
};

export const upsertRateMap = (
  fiatCode: string,
  symbol: string,
  updates: Record<string, number>,
) => {
  const current = readRateMap(fiatCode, symbol);
  kv.set(rateMapKey(fiatCode, symbol), JSON.stringify({...current, ...updates}));
};
