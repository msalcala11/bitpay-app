import React from 'react';
import {createStackNavigator} from '@react-navigation/stack';
import {
  baseNavigatorOptions,
  baseScreenOptions,
} from '../../../../constants/NavigationOptions';
import ConnectBills from './screens/ConnectBills';

export type BillStackParamList = {
  ConnectBills: {};
  //   MerchantCategory: {
  //     category: Category;
  //     integrations: DirectIntegrationApiObject[];
  //   };
  //   MerchantDetails: {directIntegration: DirectIntegrationApiObject};
};

export enum BillScreens {
  CONNECT_BILLS = 'ConnectBills',
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
    </Bill.Navigator>
  );
};

export default BillStack;
