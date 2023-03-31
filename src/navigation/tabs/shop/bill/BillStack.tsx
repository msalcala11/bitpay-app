import React from 'react';
import {createStackNavigator} from '@react-navigation/stack';
import {
  baseNavigatorOptions,
  baseScreenOptions,
} from '../../../../constants/NavigationOptions';
import ConnectBills from './screens/ConnectBills';
import Payments from './screens/Payments';
import Payment from './screens/Payment';
import {BillStatusString} from './components/BillStatus';

export type BillStackParamList = {
  ConnectBills: {};
  Payment: {account: any; billStatus: BillStatusString};
  Payments: {account?: any; accounts?: any[]};
};

export enum BillScreens {
  CONNECT_BILLS = 'ConnectBills',
  PAYMENT = 'Payment',
  PAYMENTS = 'Payments',
}

const Bill = createStackNavigator<BillStackParamList>();

const BillStack = () => {
  return (
    <Bill.Navigator
      initialRouteName={BillScreens.CONNECT_BILLS}
      screenOptions={{
        ...baseNavigatorOptions,
        ...baseScreenOptions,
      }}>
      <Bill.Screen
        options={{headerShown: false}}
        name={BillScreens.CONNECT_BILLS}
        component={ConnectBills}
      />
      <Bill.Screen name={BillScreens.PAYMENTS} component={Payments} />
      <Bill.Screen name={BillScreens.PAYMENT} component={Payment} />
    </Bill.Navigator>
  );
};

export default BillStack;
