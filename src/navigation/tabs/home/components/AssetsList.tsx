import React from 'react';
import styled from 'styled-components/native';
import {ScreenGutter} from '../../../../components/styled/Containers';
import AssetRow from './AssetRow';
import {AssetRowItem} from '../../../../utils/portfolio/assets';
import {useAssetIconResolver} from '../hooks/useAssetIconResolver';
import {useAppSelector} from '../../../../utils/hooks';
import useRuntimeFiatRateSeriesCache from '../../../../portfolio/ui/hooks/useRuntimeFiatRateSeriesCache';
import {HISTORIC_RATES_CACHE_DURATION} from '../../../../constants/wallet';
import {FIAT_RATE_SERIES_CACHED_INTERVALS} from '../../../../store/rate/rate.models';
import {getQuoteCurrency} from '../../../../utils/portfolio/assets';
import {
  getHistoricalRateAssetRequestFromItem,
  type HistoricalRateAssetRequest,
} from '../hooks/portfolioAssetHistoryRequests';
import {
  getAssetRowFiatLoading,
  getAssetRowPopulateLoading,
} from './assetRowLoading';

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

interface Props {
  items: AssetRowItem[];
  isFiatLoading?: boolean;
  populateInProgress?: boolean;
  isPopulateLoadingByKey?: Record<string, boolean>;
}

const AssetsList: React.FC<Props> = ({
  items,
  isFiatLoading,
  populateInProgress,
  isPopulateLoadingByKey,
}) => {
  const {getAssetIconData} = useAssetIconResolver();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  }).toUpperCase();
  const historicalRateRequests = React.useMemo(() => {
    return items
      .map(item =>
        getHistoricalRateAssetRequestFromItem(
          item,
          defaultAltCurrency?.isoCode || 'USD',
        ),
      )
      .filter(
        (request): request is HistoricalRateAssetRequest => request != null,
      )
      .map(request => ({
        coin: request.coin,
        chain: request.chain,
        tokenAddress: request.tokenAddress,
        intervals: [...FIAT_RATE_SERIES_CACHED_INTERVALS],
      }));
  }, [defaultAltCurrency?.isoCode, items]);
  const {cache: fiatRateSeriesCache} = useRuntimeFiatRateSeriesCache({
    quoteCurrency,
    requests: historicalRateRequests,
    maxAgeMs: HISTORIC_RATES_CACHE_DURATION * 1000,
    enabled: items.length > 0,
  });

  return (
    <List>
      {items.map((item, index) => {
        const {img, imgSrc} = getAssetIconData(item);
        const isRowPopulateLoading = getAssetRowPopulateLoading({
          populateInProgress,
          showPnlPlaceholder: item.showPnlPlaceholder,
          rowLoadingByKey: isPopulateLoadingByKey,
          rowKey: item.key,
        });
        const isRowScopedPnlLoading = !!item.showScopedPnlLoading;
        const isRowFiatLoading = getAssetRowFiatLoading({
          isFiatLoading,
          isRowPopulateLoading,
          showScopedPnlLoading: isRowScopedPnlLoading,
        });

        return (
          <AssetRow
            key={item.key}
            item={item}
            isLast={index === items.length - 1}
            isFiatLoading={isRowFiatLoading}
            isPopulateLoading={isRowPopulateLoading}
            img={img}
            imgSrc={imgSrc}
            fiatRateSeriesCache={fiatRateSeriesCache}
          />
        );
      })}
    </List>
  );
};

export default AssetsList;
