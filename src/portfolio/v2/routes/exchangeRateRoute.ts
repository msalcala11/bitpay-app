import type {FiatRateAssetRef, Interval} from '../model';
import type {PortfolioRouteScope} from './routeScope';

export type ExchangeRateRoute =
  | Readonly<{
      kind: 'marketAsset';
      fiatRateAssetRef: FiatRateAssetRef;
    }>
  | Readonly<{
      kind: 'portfolioWeightedAssetGroup';
      assetGroupId: string;
      walletIdsKey: string;
      scope: PortfolioRouteScope;
    }>;

export type SerializedExchangeRateRoute = Readonly<{
  route: ExchangeRateRoute;
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
  params: LegacyExchangeRateParams | SerializedExchangeRateRoute,
): ExchangeRateRoute {
  if ('route' in params) {
    return params.route;
  }

  return {
    kind: 'marketAsset',
    fiatRateAssetRef: {
      coin: String(params.currencyAbbreviation || '').toLowerCase(),
      chain: params.chain || params.network,
      tokenAddress: params.tokenAddress,
    },
  };
}

export function serializeExchangeRateRoute(
  route: ExchangeRateRoute,
  initialInterval?: Interval,
): SerializedExchangeRateRoute {
  return initialInterval ? {route, initialInterval} : {route};
}
