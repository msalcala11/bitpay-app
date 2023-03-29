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

const ItemContainer = styled.View`
  border-radius: 8px;
  border: 1px solid #e1e4e7;
  height: 116px;
  padding: 16px;
`;

const AccountType = styled(Paragraph)`
  font-size: 14px;
  color: ${SlateDark};
  margin-top: -5px;
`;

const AccountDetails = styled.View`
  flex-direction: row;
  align-items: center;
  flex-grow: 1;
`;

const AccountBody = styled.View`
  flex-direction: row;
`;

const AccountBalance = styled(BaseText)`
  font-size: 20px;
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

interface BillItemProps {
  variation: 'small' | 'large';
}

export default ({variation}: BillItemProps = {variation: 'large'}) => {
  const merchantIcon = 'https://static.methodfi.com/mch_logos/mch_300485.png';
  return (
    <ItemContainer>
      <AccountBody>
        <AccountDetails>
          <Image
            style={{height: 30, width: 30, marginRight: 8, marginTop: -4}}
            resizeMode={'contain'}
            source={{uri: merchantIcon}}
          />
          <View>
            <H6>AT&T</H6>
            <AccountType>Cell Phone</AccountType>
          </View>
        </AccountDetails>
        <AccountBalance>$103.64</AccountBalance>
      </AccountBody>
      <AccountActions>
        <TouchableOpacity activeOpacity={ActiveOpacity} onPress={() => {}}>
          <PayButton>
            <PayButtonText>{t('Pay Bill')}</PayButtonText>
          </PayButton>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={ActiveOpacity} onPress={() => {}}>
          <ViewAccountLink>View Account</ViewAccountLink>
        </TouchableOpacity>
        <BillStatus />
      </AccountActions>
    </ItemContainer>
  );
};
