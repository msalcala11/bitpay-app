import type {FiatRateAssetRef, Interval} from '../model';
import type {PortfolioRouteScope} from './routeScope';

export type ExchangeRateRoute =
  | Readonly<{
      kind: 'marketAsset';
      asset: FiatRateAssetRef;
      initialInterval?: Interval;
    }>
  | Readonly<{
      kind: 'portfolioWeightedAssetGroup';
      assetGroupId: string;
      scope: PortfolioRouteScope;
      initialInterval?: Interval;
    }>;

export type LegacyExchangeRateParams = Readonly<{
  currencyName?: string;
  currencyAbbreviation?: string;
  chain?: string;
  network?: string;
  tokenAddress?: string;
  chartType?: 'assetBalanceHistory' | string;
  keyId?: string;
}>;

export function normalizeExchangeRateRouteParams(
  params: LegacyExchangeRateParams | {route: ExchangeRateRoute},
): ExchangeRateRoute {
  if ('route' in params) {
    return params.route;
  }

  return {
    kind: 'marketAsset',
    asset: {
      coin: String(params.currencyAbbreviation || '').toLowerCase(),
      chain: params.chain || params.network,
      tokenAddress: params.tokenAddress,
    },
  };
}

export function serializeExchangeRateRoute(route: ExchangeRateRoute): {
  route: ExchangeRateRoute;
} {
  return {route};
}
