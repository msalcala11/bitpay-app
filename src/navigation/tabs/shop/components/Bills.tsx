import {useNavigation} from '@react-navigation/native';
import React, {useState} from 'react';
import styled from 'styled-components/native';
import {View, Image} from 'react-native';
import Button from '../../../../components/button/Button';
import {ActiveOpacity, HEIGHT} from '../../../../components/styled/Containers';
import {H5, Paragraph} from '../../../../components/styled/Text';
import {BaseText} from '../../../wallet/components/KeyDropdownOption';
import {BillScreens} from '../bill/BillStack';
import {
  SectionContainer,
  SectionHeader,
  SectionHeaderButton,
  SectionHeaderContainer,
} from './styled/ShopTabComponents';
import {SlateDark} from '../../../../styles/colors';
import CautionIconSvg from '../../../../../assets/img/bills/caution.svg';
import AddSvg from '../../../../../assets/img/bills/add.svg';
import {
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native-gesture-handler';
import {t} from 'i18next';
import BillItem from '../bill/components/BillItem';
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
  margin-bottom: -10px;
`;

const TotalDue = styled(BaseText)`
  font-size: 50px;
  font-weight: 500;
  margin-bottom: 32px;
`;

const Accounts = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
  margin-top: -15px;
  padding-left: 3px;
  margin-bottom: -15px;
`;

const AccountIcon = styled.View`
  height: 50px;
  width: 50px;
  border: 1px solid #e1e4e7;
  border-radius: 50px;
  align-items: center;
  justify-content: center;
  padding: 1px;
`;

const AccountName = styled(BaseText)`
  font-size: 12px;
  text-align: center;
  margin-top: 4px;
  font-weight: 400;
`;

const Account = styled(View)`
  flex-direction: column;
  margin-right: 20px;
  margin-top: 15px;
  width: 50px;
`;

const AddAccountIcon = styled(AccountIcon)`
  background-color: #eceffd;
  border-radius: 50px;
  border: 0;
`;

export const Bills = () => {
  const navigation = useNavigation();
  const [available, setAvailable] = useState(true);
  const [connected, setConnected] = useState(true);

  const [accounts, setAccounts] = useState([
    {
      merchantName: 'American Express',
      merchantIcon: 'https://static.methodfi.com/mch_logos/mch_300485.png',
    },
    {
      merchantName: 'Mohela',
      merchantIcon:
        'https://static.methodfi.com/mch-logos/1616215578688-mohela.png',
    },
    {
      merchantName: 'Citi',
      merchantIcon: 'https://static.methodfi.com/mch_logos/mch_302211.png',
    },
    {
      merchantName: 'Capital One',
      merchantIcon: 'https://static.methodfi.com/mch_logos/mch_301760.png',
    },
    // {
    //   merchantName: 'Credit One Bank',
    //   merchantIcon: 'https://static.methodfi.com/mch_logos/mch_303534.png',
    // },
    // {
    //   merchantName: 'Chase',
    //   merchantIcon: 'https://static.methodfi.com/mch_logos/mch_302085.png',
    // },
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
              <SectionHeaderContainer>
                <SectionHeader> {t('Connected Accounts')}</SectionHeader>
              </SectionHeaderContainer>
              <Accounts>
                {accounts.map(({merchantIcon, merchantName}) => (
                  <Account key={merchantName}>
                    <AccountIcon>
                      <Image
                        style={{height: 48, width: 48}}
                        resizeMode={'contain'}
                        source={{uri: merchantIcon}}
                      />
                    </AccountIcon>
                    <AccountName numberOfLines={1}>{merchantName}</AccountName>
                  </Account>
                ))}
                <TouchableOpacity
                  activeOpacity={ActiveOpacity}
                  onPress={() => console.log('hii')}>
                  <Account style={{marginRight: 0}}>
                    <AddAccountIcon>
                      <AddSvg />
                    </AddAccountIcon>
                    <AccountName>Add</AccountName>
                  </Account>
                </TouchableOpacity>
              </Accounts>
              <SectionHeaderContainer>
                <SectionHeader> {t('Upcoming Bills')}</SectionHeader>
                <TouchableWithoutFeedback
                  onPress={() => {
                    console.log('hi');
                    // navigation.navigate('Merchant', {
                    //   screen: MerchantScreens.MERCHANT_CATEGORY,
                    //   params: {
                    //     category,
                    //     integrations: category.integrations,
                    //   },
                    // });
                  }}>
                  <SectionHeaderButton>
                    {t('View All Bills')}
                  </SectionHeaderButton>
                </TouchableWithoutFeedback>
              </SectionHeaderContainer>
              <TouchableOpacity
                activeOpacity={ActiveOpacity}
                onPress={() => console.log('outer')}>
                <BillItem variation="large" />
              </TouchableOpacity>
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
