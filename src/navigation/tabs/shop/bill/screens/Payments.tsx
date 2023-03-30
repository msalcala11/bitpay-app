import React, {useLayoutEffect} from 'react';
import {StackScreenProps} from '@react-navigation/stack';
import {BillStackParamList} from '../BillStack';
import {t} from 'i18next';
import {HeaderTitle} from '../../../../../components/styled/Text';

const Payments = ({
  navigation,
  route,
}: //   route,
//   navigation,
StackScreenProps<BillStackParamList, 'Payments'>) => {
  const {merchant} = route.params;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => {
        return (
          <HeaderTitle>
            {merchant
              ? t(`${merchant.merchantName} Payments`)
              : t('All Payments')}
          </HeaderTitle>
        );
      },
    });
  });
  return <></>;
};

export default Payments;
