import type {Tx} from './types';

export const getTxHistoryEntryId = (tx: Tx): string => {
  'worklet';

  const id = String((tx as any)?.txid || (tx as any)?.id || '').trim();
  if (id) return id;
  return `${String((tx as any)?.time ?? '')}:${String((tx as any)?.action ?? '')}:${String((tx as any)?.amount ?? '')}:${String((tx as any)?.fees ?? '')}`;
};

export const getTxHistoryLogicalPageSize = (txs: Tx[]): number => {
  'worklet';

  if (!txs.length) return 0;

  const seen = new Set<string>();
  for (const tx of txs) {
    const id = getTxHistoryEntryId(tx);
    if (!id) continue;
    seen.add(id);
  }
  return seen.size;
};

export const dedupeTxHistoryPage = (txs: Tx[]): Tx[] => {
  'worklet';

  if (txs.length <= 1) return txs;

  const seen = new Set<string>();
  const out: Tx[] = [];
  for (const tx of txs) {
    const id = getTxHistoryEntryId(tx);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(tx);
  }
  return out;
};
