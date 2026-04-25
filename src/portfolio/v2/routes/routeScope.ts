export type PortfolioRouteScope =
  | {kind: 'home'}
  | {kind: 'key'; keyId: string}
  | {kind: 'account'; accountId: string}
  | {kind: 'wallet'; walletId: string}
  | {kind: 'walletSet'; walletIdsKey: string; walletIds: readonly string[]};
