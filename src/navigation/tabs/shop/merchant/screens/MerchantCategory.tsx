import React, {useLayoutEffect} from 'react';
import {ScrollView} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {StackScreenProps} from '@react-navigation/stack';
import {TouchableWithoutFeedback} from 'react-native-gesture-handler';
import styled from 'styled-components/native';
import MerchantItem from './../../components/MerchantItem';
import {horizontalPadding} from './../../components/styled/ShopTabComponents';
import {ShopScreens, ShopStackParamList} from '../../ShopStack';

const SearchResults = styled.View`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  padding: ${horizontalPadding}px;
`;

const MerchantCategory = ({
  route,
  navigation,
}: StackScreenProps<ShopStackParamList, 'MerchantCategory'>) => {
  const navigator = useNavigation();
  const {integrations, category} = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: category.displayName,
    });
  });

  return (
    <ScrollView>
      <SearchResults>
        {integrations.map(integration => (
          <TouchableWithoutFeedback
            key={integration.displayName}
            onPress={() =>
              navigator.navigate('Merchant', {
                screen: ShopScreens.MERCHANT_DETAILS,
                params: {
                  directIntegration: integration,
                },
              })
            }>
            <MerchantItem
              merchant={integration}
              height={200}
              key={integration.displayName}
            />
          </TouchableWithoutFeedback>
        ))}
      </SearchResults>
    </ScrollView>
  );
};

export default MerchantCategory;
