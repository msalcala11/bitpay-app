import {t} from 'i18next';
import React from 'react';
import {Image, View} from 'react-native';
import {TouchableOpacity} from 'react-native-gesture-handler';
import styled from 'styled-components/native';
import {ActiveOpacity} from '../../../../../components/styled/Containers';
import {H6, Paragraph} from '../../../../../components/styled/Text';
import {Action, SlateDark, White} from '../../../../../styles/colors';
import {BaseText} from '../../../../wallet/components/KeyDropdownOption';
import BillStatus from './BillStatus';

interface BillItemProps {
  account: any;
  variation: 'small' | 'large';
}

const ItemContainer = styled.View<Partial<BillItemProps>>`
  border-radius: 8px;
  border: 1px solid #e1e4e7;
  padding: 16px;
  padding-bottom: ${({variation}) => (variation === 'large' ? 16 : 12)}px;
  padding-top: ${({variation}) => (variation === 'large' ? 16 : 12)}px;
  padding-right: ${({variation}) => (variation === 'large' ? 16 : 12)}px;
  margin-bottom: 10px;
`;

const AccountType = styled(Paragraph)`
  font-size: 14px;
  color: ${SlateDark};
  margin-top: -5px;
`;

const AccountDetailsLeft = styled.View`
  flex-direction: row;
  align-items: center;
  flex-grow: 1;
  flex-shrink: 1;
`;

const AccountDetailsRight = styled.View`
  align-items: flex-end;
`;

const AccountBody = styled.View`
  flex-direction: row;
`;

const AccountActions = styled.View`
  margin-top: 9px;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const PayButton = styled.View`
  height: 32px;
  background-color: ${Action};
  border-radius: 50px;
  max-width: 90px;
  min-width: 50px;
  padding: 0 20px;
  align-items: center;
  justify-content: center;
`;

const PayButtonText = styled(Paragraph)`
  font-size: 14px;
  color: ${White};
`;

const ViewAccountLink = styled(Paragraph)`
  color: ${Action};
`;

const AccountBalance = styled(BaseText)<Partial<BillItemProps>>`
  font-size: ${({variation}) => (variation === 'large' ? 20 : 16)}px;
  margin-top: ${({variation}) => (variation === 'large' ? -1 : 3)}px;
`;

export default (
  {account, variation}: BillItemProps = {account: {}, variation: 'large'},
) => {
  return (
    <ItemContainer variation={variation}>
      <AccountBody>
        <AccountDetailsLeft>
          <Image
            style={{height: 30, width: 30, marginRight: 8, marginTop: -4}}
            resizeMode={'contain'}
            source={{uri: account.merchantIcon}}
          />
          <View>
            <H6 style={{maxWidth: 175}} numberOfLines={1}>
              {account.merchantName}
            </H6>
            <AccountType>Credit Card</AccountType>
          </View>
        </AccountDetailsLeft>
        <AccountDetailsRight>
          {variation === 'small' ? <BillStatus /> : null}
          <AccountBalance variation={variation}>$103.64</AccountBalance>
        </AccountDetailsRight>
      </AccountBody>
      {variation === 'large' ? (
        <AccountActions>
          <TouchableOpacity
            activeOpacity={ActiveOpacity}
            onPress={() => console.log('pay bill')}>
            <PayButton>
              <PayButtonText>{t('Pay Bill')}</PayButtonText>
            </PayButton>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={ActiveOpacity}
            onPress={() => console.log('view account')}>
            <ViewAccountLink>View Account</ViewAccountLink>
          </TouchableOpacity>
          <BillStatus />
        </AccountActions>
      ) : null}
    </ItemContainer>
  );
};
