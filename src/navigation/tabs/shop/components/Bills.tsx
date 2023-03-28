import {useNavigation} from '@react-navigation/native';
import React, {useState} from 'react';
import styled from 'styled-components/native';
import {View} from 'react-native';
import Button from '../../../../components/button/Button';
import {HEIGHT} from '../../../../components/styled/Containers';
import {H5, Paragraph} from '../../../../components/styled/Text';
import {BaseText} from '../../../wallet/components/KeyDropdownOption';
import {BillScreens} from '../bill/BillStack';
import {SectionContainer} from './styled/ShopTabComponents';
import {SlateDark} from '../../../../styles/colors';
import CautionIconSvg from '../../../../../assets/img/bills/caution.svg';
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
  width: 310px;
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

const CautionIcon = styled(CautionIconSvg)`
  margin-bottom: 24px;
`;

export const Bills = () => {
  const navigation = useNavigation();
  const [available, setAvailable] = useState(false);

  return (
    <>
      {available ? (
        <SectionContainer style={{height: HEIGHT - 270}}>
          <BillsValueProp>
            <BillsImage source={BillsZeroState} />
            <TitleContainer>
              <Title>
                Pay bills straight from your{' '}
                <BoldTitle>BitPay wallet</BoldTitle>
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
      ) : (
        <SectionContainer style={{height: HEIGHT - 270}}>
          <BillsValueProp>
            <CautionIcon />
            <H5>Bill Pay isn't available in your area</H5>
            <Subtitle>
              Currently Bill Pay is only supported within the United States.
              However, we are constantly adding support for new locations. Check
              back soon.
            </Subtitle>
          </BillsValueProp>
          <Button
            height={50}
            disabled
            onPress={() => {
              navigation.navigate('Bill', {
                screen: BillScreens.CONNECT_BILLS,
                params: {},
              });
            }}>
            Connect My Bills
          </Button>
        </SectionContainer>
      )}
    </>
  );
};
