import React from 'react';
import {createStackNavigator} from '@react-navigation/stack';
import {
  baseNavigatorOptions,
  baseScreenOptions,
} from '../../../../constants/NavigationOptions';
import ConnectBills from './screens/ConnectBills';
import Payments from './screens/Payments';

export type BillStackParamList = {
  ConnectBills: {};
  Payments: {account?: any; accounts?: any[]};
};

export enum BillScreens {
  CONNECT_BILLS = 'ConnectBills',
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
    </Bill.Navigator>
  );
};

export default BillStack;
