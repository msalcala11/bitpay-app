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

  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    for (let hashIndex = 0; hashIndex < hashes.length; hashIndex++) {
      hashes[hashIndex] ^= code + hashIndex * 0x9e37 + i;
      hashes[hashIndex] = Math.imul(hashes[hashIndex], 0x01000193);
    }
  }

  return `fnv1a128:${hashes
    .map(hash => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('')}`;
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

  return `walletIds:v2:${uniqueSorted.length}:${stableHash(framedPayload)}`;
}
