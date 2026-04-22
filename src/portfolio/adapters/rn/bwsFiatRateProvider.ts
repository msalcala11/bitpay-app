import {
  getFiatRateSeriesUrl,
  type FiatRateSeriesResponse,
} from '../../core/fiatRatesShared';
import type {FiatRateProvider} from '../../core/pnl/fiatRateStore';
import type {NitroResponse as NitroFetchResponse} from 'react-native-nitro-fetch';
import {
  DEFAULT_PORTFOLIO_NITRO_FETCH_TIMEOUT_MS,
  getPortfolioNitroFetchClientOnRuntime,
} from './txHistorySigning';

export class RnBwsFiatRateProvider implements FiatRateProvider {
  async loadSeries(
    args: Parameters<FiatRateProvider['loadSeries']>[0],
  ): Promise<FiatRateSeriesResponse> {
    'worklet';

    const url = getFiatRateSeriesUrl(
      args.cfg,
      args.quoteCurrency,
      args.interval,
      args.asset,
    );

    const nitroFetchClient = getPortfolioNitroFetchClientOnRuntime();
    let response: NitroFetchResponse;
    try {
      response = nitroFetchClient.requestSync({
        url,
        method: 'GET',
        headers: [
          {key: 'Accept', value: 'application/json'},
          {key: 'Cache-Control', value: 'no-store'},
        ],
        timeoutMs: DEFAULT_PORTFOLIO_NITRO_FETCH_TIMEOUT_MS,
        followRedirects: true,
      });
    } catch (error: unknown) {
      const runtimeError =
        error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `Portfolio Nitro Fetch fiat-rate request failed for ${url}: ${runtimeError.message}`,
      );
    }

    const rawResponseText =
      typeof response.bodyString === 'string' ? response.bodyString : '';
    if (!response.ok) {
      const responsePreview = rawResponseText.slice(0, 400);
      throw new Error(
        `Failed to fetch fiat rates (${response.status}) for ${url}. ${responsePreview}`,
      );
    }

    try {
      return (rawResponseText ? JSON.parse(rawResponseText) : {}) as FiatRateSeriesResponse;
    } catch {
      return {} as FiatRateSeriesResponse;
    }
  }
}
