import React, {useLayoutEffect, useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {RootStackParamList} from '../../../../Root';
import {useTheme} from 'styled-components/native';
import {useStackScreenOptions} from '../../../utils/headerHelpers';
import {HeaderTitle} from '../../../../components/styled/Text';
import HeaderBackButton from '../../../../components/back/HeaderBackButton';
import {EmptyListContainer} from '../../../../components/styled/Containers';
import {H5} from '../../../../components/styled/Text';
import GhostSvg from '../../../../../assets/img/ghost-straight-face.svg';
import AssetsGainLossDropdown from '../components/AssetsGainLossDropdown';
import AssetsSearchPill from '../components/AssetsSearchPill';
import AssetsList from '../components/AssetsList';
import {
  findSupportedCurrencyOptionForAsset,
  GainLossMode,
} from '../../../../utils/assets';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../../../constants/currencies';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {useAppSelector} from '../../../../utils/hooks';
import {getCurrencyAbbreviation} from '../../../../utils/helper-methods';
import usePortfolioAssetRows from '../hooks/usePortfolioAssetRows';

type Props = NativeStackScreenProps<RootStackParamList, 'AllAssets'>;

const ScreenContainer = styled.SafeAreaView`
  flex: 1;
`;

const Content = styled.ScrollView`
  flex: 1;
`;

const FiltersRow = styled.View`
  flex-direction: row;
  gap: 12px;
  padding: 12px 16px;
`;

const FILTER_HEIGHT = 40;

const AllAssets: React.FC<Props> = ({navigation, route}) => {
  const theme = useTheme();
  const commonOptions = useStackScreenOptions(theme);
  const [query, setQuery] = useState('');
  const [gainLossMode, setGainLossMode] = useState<GainLossMode>('1D');

  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);

  const keyId = route.params?.keyId;
  const {isFiatLoading, items, visibleItems, isPopulateLoadingByKey} =
    usePortfolioAssetRows({
      gainLossMode,
      keyId,
    });

  useLayoutEffect(() => {
    navigation.setOptions({
      ...commonOptions,
      headerLeft: () => <HeaderBackButton />,
      headerTitle: () => <HeaderTitle>Assets</HeaderTitle>,
    });
  }, [navigation, commonOptions]);

  const searchableVisibleItems = useMemo(() => {
    return visibleItems.map(item => {
      const option = findSupportedCurrencyOptionForAsset({
        options: SupportedCurrencyOptions,
        currencyAbbreviation: item.currencyAbbreviation,
        chain: item.chain,
        tokenAddress: item.tokenAddress,
      });

      const optionCurrencyName = option?.currencyName;
      const chainDisplayName =
        BitpaySupportedCoins[option?.chain || item.chain]?.name;
      const tokenDisplayName = option?.tokenAddress
        ? BitpaySupportedTokens[
            getCurrencyAbbreviation(option.tokenAddress, option.chain)
          ]?.name
        : undefined;

      return {
        item,
        searchText: [
          item.name,
          item.currencyAbbreviation,
          item.chain,
          optionCurrencyName || '',
          chainDisplayName || '',
          tokenDisplayName || '',
        ]
          .join('\u0000')
          .toLowerCase(),
      };
    });
  }, [visibleItems]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return visibleItems;
    }

    return searchableVisibleItems
      .filter(({searchText}) => searchText.includes(q))
      .map(({item}) => item);
  }, [query, searchableVisibleItems, visibleItems]);

  const showGhostTown = !items.length;

  return (
    <ScreenContainer>
      <Content>
        <FiltersRow>
          <AssetsSearchPill
            value={query}
            onChangeText={setQuery}
            height={FILTER_HEIGHT}
          />
          <AssetsGainLossDropdown
            onPress={() => {}}
            onChange={value => setGainLossMode(value)}
            height={FILTER_HEIGHT}
          />
        </FiltersRow>

        {showGhostTown ? (
          <EmptyListContainer>
            <H5>{"It's a ghost town in here"}</H5>
            <GhostSvg style={{marginTop: 20}} />
          </EmptyListContainer>
        ) : (
          <AssetsList
            items={filteredItems}
            isFiatLoading={isFiatLoading}
            isPopulateLoading={portfolio.populateStatus?.inProgress}
            isPopulateLoadingByKey={isPopulateLoadingByKey}
          />
        )}
      </Content>
    </ScreenContainer>
  );
};

export default AllAssets;
