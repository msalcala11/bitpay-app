import React, {useLayoutEffect} from 'react';
import {StackScreenProps} from '@react-navigation/stack';
import {BillStackParamList} from '../BillStack';
import {t} from 'i18next';
import {HeaderTitle, Paragraph} from '../../../../../components/styled/Text';
import styled from 'styled-components/native';
import Button from '../../../../../components/button/Button';
import {BaseText} from '../../../../wallet/components/KeyDropdownOption';

const HeroSection = styled.View`
  background-color: #eceffd;
  width: 100%;
  padding: 16px;
`;

const AmountDue = styled(BaseText)`
  font-size: 50px;
  font-weight: 500;
  text-align: center;
  margin-top: 110px;
`;

const DueDate = styled(Paragraph)`
  margin-bottom: 20px;
  text-align: center;
`;

const Payments = ({
  navigation,
  route,
}: //   route,
//   navigation,
StackScreenProps<BillStackParamList, 'Payments'>) => {
  const {merchant} = route.params;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTransparent: true,
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
  return (
    <HeroSection>
      <AmountDue>$103.64</AmountDue>
      <DueDate>Amount due: 01/31/23</DueDate>
      <Button height={50} onPress={() => console.log('hi')}>
        Pay Bill
      </Button>
    </HeroSection>
  );
};

export default Payments;
