export function dedupeStringArray(
  values: readonly string[],
): readonly string[] {
  return Array.from(
    new Set(values.map(value => String(value || '').trim()).filter(Boolean)),
  );
}

export function stableWalletIdsKey(walletIds: readonly string[]): string {
  return dedupeStringArray(walletIds).slice().sort().join('|');
}
