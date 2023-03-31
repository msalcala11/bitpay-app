import React, {useLayoutEffect} from 'react';
import {StackScreenProps} from '@react-navigation/stack';
import {BillStackParamList} from '../BillStack';
import {t} from 'i18next';
import {
  H6,
  H7,
  HeaderTitle,
  Paragraph,
} from '../../../../../components/styled/Text';
import styled from 'styled-components/native';
import Button from '../../../../../components/button/Button';
import {BaseText} from '../../../../wallet/components/KeyDropdownOption';
import {Image, View} from 'react-native';
import {Black, SlateDark} from '../../../../../styles/colors';
import {SectionContainer} from '../../components/styled/ShopTabComponents';
import {BillStatusString} from '../components/BillStatus';

const HeroSection = styled.View<{status: BillStatusString}>`
  background-color: ${({status}) =>
    status === 'complete' ? '#CBF3E880' : '#eceffd'};
  width: 100%;
  padding: 16px;
`;

const AmountDue = styled(BaseText)<{status: BillStatusString}>`
  color: ${({status}) => (status === 'complete' ? '#0B754A' : Black)};
  font-size: 50px;
  font-weight: 500;
  text-align: center;
  margin-top: 110px;
`;

const DueDate = styled(Paragraph)`
  margin-bottom: 20px;
  text-align: center;
`;

const AccountDetails = styled.View`
  background-color: #fbfbff;
  flex-direction: row;
  align-items: center;
  padding: 16px;
`;

const AccountIcon = styled.View`
  height: 40px;
  width: 40px;
  //   border: 1px solid #e1e4e7;
  border-radius: 40px;
  align-items: center;
  justify-content: center;
  margin-right: 16px;
  //   padding: 1px;
`;

const LineItems = styled.View`
  flex-grow: 1;
`;

const LineItem = styled.View`
  flex-direction: row;
  padding: 18px 0;
  border-bottom-width: 1px;
  border-bottom-color: #e1e4e7;
  align-items: center;
`;

const LineItemLabel = styled(H7)`
  flex-grow: 1;
`;

const Payment = ({
  navigation,
  route,
}: StackScreenProps<BillStackParamList, 'Payment'>) => {
  const {account, billStatus} = route.params;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTransparent: true,
      headerTitle: () => {
        return <HeaderTitle>{t('Bill Details')}</HeaderTitle>;
      },
    });
  });
  return (
    <>
      <HeroSection status={billStatus}>
        <AmountDue status={billStatus}>$103.64</AmountDue>
        <DueDate>
          {billStatus === 'complete' ? t('Amount Paid') : t('Current Balance')}
        </DueDate>
      </HeroSection>
      <AccountDetails>
        <AccountIcon>
          <Image
            style={{height: 40, width: 40}}
            resizeMode={'contain'}
            source={{uri: account.merchantIcon}}
          />
        </AccountIcon>
        <View>
          <H6>{account.merchantName}</H6>
          <Paragraph style={{color: SlateDark}}>Credit Card ****1234</Paragraph>
        </View>
      </AccountDetails>
      <SectionContainer style={{marginTop: 20, flexGrow: 1}}>
        <LineItems>
          {billStatus === 'complete' ? (
            <LineItem>
              <LineItemLabel>Payment completed on</LineItemLabel>
              <Paragraph>Mar 3, 2023</Paragraph>
            </LineItem>
          ) : (
            <LineItem>
              <LineItemLabel>Amount due</LineItemLabel>
              <Paragraph>$25.00</Paragraph>
            </LineItem>
          )}
          <LineItem>
            <LineItemLabel>Next payment date</LineItemLabel>
            <Paragraph>April 1, 2023</Paragraph>
          </LineItem>
        </LineItems>
        {billStatus === 'dueSoon' ? (
          <Button style={{marginBottom: 40}}>Pay Bill</Button>
        ) : null}
      </SectionContainer>
    </>
  );
};

export default Payment;
