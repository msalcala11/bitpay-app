import React from 'react';
import {TouchableOpacity} from 'react-native-gesture-handler';
import {ActiveOpacity} from '../../../../../components/styled/Containers';
import BillItem from './BillItem';

export const BillList = ({accounts, variation, onPress}: any) => {
  return accounts.map((account: any) => (
    <TouchableOpacity
      activeOpacity={ActiveOpacity}
      onPress={() => {
        onPress(account);
      }}>
      <BillItem variation={variation} />
    </TouchableOpacity>
  ));
};
