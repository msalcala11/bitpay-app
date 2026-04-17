import {
  getFiatRateSeriesUrl,
  type FiatRateSeriesResponse,
} from '../../core/fiatRatesShared';
import type {FiatRateProvider} from '../../core/pnl/fiatRateStore';

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

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (error: unknown) {
      const runtimeError = error instanceof Error ? error : new Error(String(error));
      throw new Error(
        `Portfolio fiat-rate request failed for ${url}: ${runtimeError.message}`,
      );
    }

    if (!response.ok) {
      const responsePreview = (await response.text()).slice(0, 400);
      throw new Error(
        `Failed to fetch fiat rates (${response.status}) for ${url}. ${responsePreview}`,
      );
    }

    return (await response.json()) as FiatRateSeriesResponse;
  }
}
