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
import RemoteImage from './RemoteImage';
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

const TotalBillsBox = styled.View`
  background-color: #eceffd;
  border-radius: 16px;
  margin-top: 16px;
  padding: 24px;
`;

const TotalDue = styled(BaseText)`
  font-size: 50px;
  font-weight: 500;
  margin-bottom: 32px;
`;

const SectionTitle = styled(H5)`
  margin-bottom: 12px;
  margin-top: 32px;
`;

const Accounts = styled.View`
  flex-direction: row;
`;

const AccountIcon = styled.View`
  height: 50px;
  width: 50px;
  margin-right: 20px;
`;

export const Bills = () => {
  const navigation = useNavigation();
  const [available, setAvailable] = useState(true);
  const [connected, setConnected] = useState(true);

  const [accounts, setAccounts] = useState([
    'https://static.methodfi.com/mch_logos/mch_300485.png',
    'https://static.methodfi.com/mch-logos/1616215578688-mohela.png',
    'https://static.methodfi.com/mch_logos/mch_302211.png',
  ]);

  return (
    <>
      {available ? (
        <SectionContainer style={{height: HEIGHT - 270}}>
          {!connected ? (
            <>
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
            </>
          ) : (
            <>
              <TotalBillsBox>
                <Paragraph>Total Bills Due</Paragraph>
                <TotalDue>$1462.14</TotalDue>
                <Button buttonStyle={'secondary'} height={50}>
                  View All Bills
                </Button>
              </TotalBillsBox>
              <SectionTitle>Connected accounts</SectionTitle>
              <Accounts>
                {accounts.map(accountIcon => (
                  <AccountIcon>
                    <RemoteImage
                      borderRadius={50}
                      height={50}
                      uri={accountIcon}
                    />
                  </AccountIcon>
                ))}
              </Accounts>
              <SectionTitle>Upcoming Bills</SectionTitle>
            </>
          )}
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
