import React from 'react';
import {TouchableOpacity} from 'react-native-gesture-handler';
import {ActiveOpacity} from '../../../../../components/styled/Containers';
import BillItem from './BillItem';

export const BillList = ({accounts, variation, onPress, billStatus}: any) => {
  return accounts.map((account: any) => (
    <TouchableOpacity
      key={account.merchantName}
      activeOpacity={ActiveOpacity}
      onPress={() => {
        onPress(account);
      }}>
      <BillItem
        account={account}
        variation={variation}
        onViewAccount={() => onPress(account)}
        billStatus={billStatus}
      />
    </TouchableOpacity>
  ));
};
