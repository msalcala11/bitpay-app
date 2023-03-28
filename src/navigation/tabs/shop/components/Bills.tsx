import {useNavigation} from '@react-navigation/native';
import React from 'react';
import styled from 'styled-components/native';
import {View} from 'react-native';
import Button from '../../../../components/button/Button';
import {HEIGHT} from '../../../../components/styled/Containers';
import {Paragraph} from '../../../../components/styled/Text';
import {BaseText} from '../../../wallet/components/KeyDropdownOption';
import {BillScreens} from '../bill/BillStack';
import {SectionContainer} from './styled/ShopTabComponents';
import {SlateDark} from '../../../../styles/colors';
const BillsZeroState = require('../../../../../assets/img/bills/bills-zero-state.png');

const Title = styled(BaseText)`
  font-size: 24px;
  font-weight: 400;
  line-height: 28px;
  text-align: center;
  margin-top: 20px;
  width: 341px;
`;

const BoldTitle = styled(Title)`
  font-weight: 600;
`;

const Subtitle = styled(Paragraph)`
  font-size: 14px;
  line-height: 21px;
  width: 380px;
  margin-top: 10px;
  color: ${SlateDark};
  text-align: center;
`;

const TitleContainer = styled.View`
  align-items: center;
`;

const BillsValueProp = styled.View`
  flex-grow: 1;
  align-items: center;
  justify-content: center;
`;

const BillsImage = styled.Image`
  width: 292px;
  height: 279px;
`;

export const Bills = () => {
  const navigation = useNavigation();

  return (
    <SectionContainer style={{height: HEIGHT - 270}}>
      <BillsValueProp>
        <BillsImage source={BillsZeroState} />
        <TitleContainer>
          <Title>
            Pay bills straight from your <BoldTitle>BitPay wallet</BoldTitle>
          </Title>
          <Subtitle>
            Make payments on everything from credit cards to mortgages.
          </Subtitle>
        </TitleContainer>
      </BillsValueProp>
      <Button
        height={50}
        onPress={() => {
          navigation.navigate('Bill', {
            screen: BillScreens.CONNECT_BILLS,
            params: {},
          });
        }}>
        Connect My Bills
      </Button>
      <View style={{height: 10}} />
      <Button buttonStyle={'secondary'} height={50}>
        Login
      </Button>
    </SectionContainer>
  );
};
