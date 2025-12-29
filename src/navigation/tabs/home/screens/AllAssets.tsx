import React, {useLayoutEffect, useMemo, useState} from 'react';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {RootStackParamList} from '../../../../Root';
import {useTheme} from 'styled-components/native';
import {useStackScreenOptions} from '../../../utils/headerHelpers';
import {HeaderTitle} from '../../../../components/styled/Text';
import HeaderBackButton from '../../../../components/back/HeaderBackButton';
import AssetsGainLossDropdown from '../components/AssetsGainLossDropdown';
import AssetsSearchPill from '../components/AssetsSearchPill';
import AssetsList from '../components/AssetsList';
import {getAllAssetsMockItems} from '../components/AssetsMockData';

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

const AllAssets: React.FC<Props> = ({navigation}) => {
  const theme = useTheme();
  const commonOptions = useStackScreenOptions(theme);
  const [query, setQuery] = useState('');

  useLayoutEffect(() => {
    navigation.setOptions({
      ...commonOptions,
      headerLeft: () => <HeaderBackButton />,
      headerTitle: () => <HeaderTitle>Assets</HeaderTitle>,
    });
  }, [navigation, commonOptions]);

  const items = useMemo(() => getAllAssetsMockItems(), []);
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return items;
    }

    return items.filter(item => {
      return (
        item.name.toLowerCase().includes(q) ||
        item.currencyAbbreviation.toLowerCase().includes(q) ||
        item.chain.toLowerCase().includes(q)
      );
    });
  }, [items, query]);

  return (
    <ScreenContainer>
      <Content>
        <FiltersRow>
          <AssetsSearchPill value={query} onChangeText={setQuery} height={FILTER_HEIGHT} />
          <AssetsGainLossDropdown onPress={() => {}} height={FILTER_HEIGHT} />
        </FiltersRow>

        <AssetsList items={filteredItems} />
      </Content>
    </ScreenContainer>
  );
};

export default AllAssets;
