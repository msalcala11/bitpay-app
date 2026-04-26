export type PortfolioRouteScope =
  | {kind: 'home'}
  | {kind: 'wallet'; walletId: string}
  | {kind: 'key'; keyId: string}
  | {kind: 'account'; accountId: string}
  | {kind: 'assetGroup'; assetGroupId: string}
  | {kind: 'keyAssetGroup'; keyId: string; assetGroupId: string}
  | {kind: 'accountAssetGroup'; accountId: string; assetGroupId: string}
  | {kind: 'walletIdsKey'; walletIdsKey: string};

export type ResolvedRouteScope = Readonly<{
  scope: PortfolioRouteScope;
  walletIds: readonly string[];
  walletIdsKey: string;
  assetGroupId?: string;
}>;
