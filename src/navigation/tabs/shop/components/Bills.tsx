import {useNavigation} from '@react-navigation/native';
import React from 'react';
import {View} from 'react-native';
import Button from '../../../../components/button/Button';
import {HEIGHT} from '../../../../components/styled/Containers';
import {BillScreens} from '../bill/BillStack';
import {SectionContainer} from './styled/ShopTabComponents';

export const Bills = () => {
  const navigation = useNavigation();

  return (
    <View style={{flexDirection: 'column', height: HEIGHT - 270}}>
      <View style={{flexGrow: 1}} />
      <SectionContainer>
        <Button
          onPress={() => {
            navigation.navigate('Bill', {
              screen: BillScreens.CONNECT_BILLS,
              params: {},
            });
          }}>
          Connect My Bills
        </Button>
        <View style={{height: 10}} />
        <Button buttonStyle={'secondary'}>Login</Button>
      </SectionContainer>
    </View>
  );
};
