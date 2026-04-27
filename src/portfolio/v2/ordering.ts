export function dedupeStringArray(
  values: readonly string[],
): readonly string[] {
  'worklet';

  return Array.from(
    new Set(values.map(value => String(value || '').trim()).filter(Boolean)),
  );
}

function stableHash(input: string): string {
  'worklet';

  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function lengthFrame(value: string): string {
  'worklet';

  return `${value.length}:${value}`;
}

export function stableWalletIdsKey(walletIds: readonly string[]): string {
  'worklet';

  const uniqueSorted = dedupeStringArray(walletIds)
    .slice()
    .sort((a, b) => a.localeCompare(b));
  const framedPayload = [
    `count:${uniqueSorted.length}`,
    ...uniqueSorted.map(lengthFrame),
  ].join('|');

  return `walletIds:v1:${uniqueSorted.length}:${stableHash(framedPayload)}`;
}
