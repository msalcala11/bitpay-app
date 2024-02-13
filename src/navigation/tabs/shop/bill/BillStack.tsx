import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {baseNavigatorOptions} from '../../../../constants/NavigationOptions';
import {AmountScreenParamList} from '../../../wallet/screens/AmountScreen';
import {BillConfirmParamList} from '../../../wallet/screens/send/confirm/BillConfirm';
import {HeaderTitle} from '../../../../components/styled/Text';
import {PayProConfirmTwoFactorParamList} from '../../../wallet/screens/send/confirm/PayProConfirmTwoFactor';
import {BillPayAccount, BillPayment} from '../../../../store/shop/shop.models';
import BillsHome from './screens/BillsHome';
import {useTheme} from 'styled-components/native';

export type BillStackParamList = {
  BillsHome: {};
  BillAmount: AmountScreenParamList;
  BillConfirm: BillConfirmParamList;
  BillConfirmTwoFactor: PayProConfirmTwoFactorParamList;
  ConnectBills: {tokenType: 'auth' | 'link'};
  ConnectBillsOptions: {};
  BillSettings: {};
  Payment: {account: BillPayAccount; payment: BillPayment};
  PayBill: {account: BillPayAccount};
  PayAllBills: {accounts: BillPayAccount[]};
  Payments: {account?: BillPayAccount};
};

export enum BillScreens {
  BILLS_HOME = 'BillsHome',
  BILL_AMOUNT = 'BillAmount',
  BILL_CONFIRM = 'BillConfirm',
  BILL_CONFIRM_TWO_FACTOR = 'BillConfirmTwoFactor',
  BILL_SETTINGS = 'BillSettings',
  CONNECT_BILLS = 'ConnectBills',
  CONNECT_BILLS_OPTIONS = 'ConnectBillsOptions',
  PAYMENT = 'Payment',
  PAY_BILL = 'PayBill',
  PAY_ALL_BILLS = 'PayAllBills',
  PAYMENTS = 'Payments',
}

const Bill = createNativeStackNavigator<BillStackParamList>();

const BillStack = () => {
  const {t} = useTranslation();
  const theme = useTheme();
  return (
    <Bill.Navigator
      initialRouteName={BillScreens.BILLS_HOME}
      screenOptions={() => ({
        ...baseNavigatorOptions,
        headerStyle: {
          backgroundColor: theme.colors.background,
        },
      })}>
      <Bill.Screen
        name={BillScreens.BILLS_HOME}
        component={BillsHome}
        options={{
          headerTitle: () => <HeaderTitle>{t('Pay Bills')}</HeaderTitle>,
        }}
      />
    </Bill.Navigator>
  );
};

export default BillStack;
