export type SnapshotKvKeyParts = Readonly<{
  walletId: string;
  chunkId?: string;
}>;

export function getSnapshotMetaKey(walletId: string): string {
  return `snap:meta:v2:${walletId}`;
}

export function getSnapshotIndexKey(walletId: string): string {
  return `snap:index:v2:${walletId}`;
}

export function getSnapshotChunkKey(args: SnapshotKvKeyParts): string {
  return `snap:chunk:v2:${args.walletId}:${args.chunkId ?? '0'}`;
}
