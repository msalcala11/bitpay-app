import React from 'react';
import AssetBalanceHistoryScreen from './exchange-rate/AssetBalanceHistoryScreen';
import ExchangeRateScreen from './exchange-rate/ExchangeRateScreen';
import useExchangeRateSharedModel from './exchange-rate/useExchangeRateSharedModel';
import {useDevRenderTrace} from '../../../utils/hooks/useDevRenderTrace';

const AssetDetails = () => {
  const shared = useExchangeRateSharedModel();

  useDevRenderTrace('AssetDetails', {
    mode: shared.isAssetBalanceHistoryMode
      ? 'assetBalanceHistory'
      : 'exchangeRate',
    assetKey: [
      shared.assetContext.currencyAbbreviation,
      shared.assetContext.chain,
      shared.assetContext.tokenAddress || '',
    ].join(':'),
    resolvedQuoteCurrency: shared.resolvedQuoteCurrency,
    assetWalletCount: shared.assetWallets.length,
    assetTotalFiatBalance: shared.assetTotalFiatBalance,
    currentFiatRate: shared.currentFiatRate ?? null,
  });

  if (shared.isAssetBalanceHistoryMode) {
    return <AssetBalanceHistoryScreen shared={shared} />;
  }

  return <ExchangeRateScreen shared={shared} />;
};

export default AssetDetails;
