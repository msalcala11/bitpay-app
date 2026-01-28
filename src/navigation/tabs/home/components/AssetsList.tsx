import React from 'react';
import styled from 'styled-components/native';
import {ScreenGutter} from '../../../../components/styled/Containers';
import AssetRow from './AssetRow';
import {
  AssetRowItem,
  findSupportedCurrencyOptionForAsset,
} from '../../../../utils/assets';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../../../constants/currencies';
import {getCurrencyAbbreviation} from '../../../../utils/helper-methods';

const List = styled.View`
  margin: 10px ${ScreenGutter} 10px;
`;

interface Props {
  items: AssetRowItem[];
  onRowPress?: (item: AssetRowItem) => void;
  isFiatLoading?: boolean;
  isPopulateLoading?: boolean;
  isPopulateLoadingByKey?: Record<string, boolean>;
}

export const isExchangeRateSupported = (item: AssetRowItem): boolean => {
  const option = findSupportedCurrencyOptionForAsset({
    options: SupportedCurrencyOptions,
    currencyAbbreviation: item.currencyAbbreviation,
    chain: item.chain,
    tokenAddress: item.tokenAddress,
  });

  if (!option) {
    return false;
  }

  const currencyName = getCurrencyAbbreviation(
    option.tokenAddress ? option.tokenAddress : option.currencyAbbreviation,
    option.chain,
  );
  const isStableCoin =
    BitpaySupportedCoins[currencyName]?.properties?.isStableCoin ||
    BitpaySupportedTokens[currencyName]?.properties?.isStableCoin;

  return !isStableCoin;
};

const AssetsList: React.FC<Props> = ({
  items,
  onRowPress,
  isFiatLoading,
  isPopulateLoading,
  isPopulateLoadingByKey,
}) => {
  return (
    <List>
      {items.map((item, index) => {
        const supported = isExchangeRateSupported(item);
        const isRowPopulateLoading =
          typeof isPopulateLoadingByKey?.[item.key] === 'boolean'
            ? isPopulateLoadingByKey[item.key]
            : isPopulateLoading;

        return (
          <AssetRow
            key={item.key}
            item={item}
            isLast={index === items.length - 1}
            isExchangeRateSupported={supported}
            isFiatLoading={isFiatLoading}
            isPopulateLoading={isRowPopulateLoading}
            onPress={
              supported && onRowPress ? () => onRowPress(item) : undefined
            }
          />
        );
      })}
    </List>
  );
};

export default AssetsList;
