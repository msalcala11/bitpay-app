import {useNavigation} from '@react-navigation/native';
import {createStackNavigator} from '@react-navigation/stack';
import React from 'react';
import {useDispatch, useSelector} from 'react-redux';
import Button from '../../components/button/Button';
import haptic from '../../components/haptic-feedback/haptic';
import {HeaderRightContainer} from '../../components/styled/Containers';
import {HeaderTitle} from '../../components/styled/Text';
import {
  baseNavigatorOptions,
  baseScreenOptions,
} from '../../constants/NavigationOptions';
import {RootState} from '../../store';
import {BitPayIdEffects} from '../../store/bitpay-id';
import {User} from '../../store/bitpay-id/bitpay-id.models';
import {ShopEffects} from '../../store/shop';
import PairingScreen, {
  BitPayIdPairingScreenParamList,
} from './screens/BitPayIdPairingScreen';
import Profile from './screens/ProfileSettings';
import ReceivingAddresses from './screens/ReceivingAddresses';
import {useTranslation} from 'react-i18next';
import ReceivingEnabled from './screens/RecevingEnabled';

export type BitpayIdStackParamList = {
  BitPayIdPairingScreen: BitPayIdPairingScreenParamList;
  Profile: undefined;
  ReceivingAddresses: undefined;
  ReceivingEnabled: undefined;
};

export enum BitpayIdScreens {
  PAIRING = 'BitPayIdPairingScreen',
  PROFILE = 'Profile',
  RECEIVING_ADDRESSES = 'ReceivingAddresses',
  RECEIVING_ENABLED = 'ReceivingEnabled',
}

const BitpayId = createStackNavigator<BitpayIdStackParamList>();

const BitpayIdStack = () => {
  const {t} = useTranslation();
  const dispatch = useDispatch();
  const navigation = useNavigation();
  const user = useSelector<RootState, User | null>(
    ({APP, BITPAY_ID}) => BITPAY_ID.user[APP.network],
  );

  return (
    <BitpayId.Navigator
      screenOptions={{...baseNavigatorOptions}}
      initialRouteName={BitpayIdScreens.PROFILE}>
      <BitpayId.Screen
        name={BitpayIdScreens.PAIRING}
        component={PairingScreen}
        options={{
          ...baseScreenOptions,
          headerTitle: () => <HeaderTitle>{t('Pairing...')}</HeaderTitle>,
        }}
      />
      <BitpayId.Screen
        name={BitpayIdScreens.PROFILE}
        component={Profile}
        options={{
          ...baseScreenOptions,
          headerRight: () => {
            return (
              <HeaderRightContainer>
                <Button
                  buttonType={'pill'}
                  onPress={() => {
                    haptic('impactLight');

                    if (user) {
                      navigation.navigate('Tabs', {
                        screen: 'Settings',
                      });

                      dispatch(BitPayIdEffects.startDisconnectBitPayId());
                      dispatch(ShopEffects.startFetchCatalog());
                    } else {
                      navigation.navigate('Auth', {screen: 'Login'});
                    }
                  }}>
                  {user ? t('Log Out') : t('Log In')}
                </Button>
              </HeaderRightContainer>
            );
          },
        }}
      />
      <BitpayId.Screen
        name={BitpayIdScreens.RECEIVING_ADDRESSES}
        component={ReceivingAddresses}
        options={{
          ...baseScreenOptions,
        }}
      />
      <BitpayId.Screen
        name={BitpayIdScreens.RECEIVING_ENABLED}
        component={ReceivingEnabled}
        options={{
          ...baseScreenOptions,
        }}
      />
    </BitpayId.Navigator>
  );
};

export default BitpayIdStack;
