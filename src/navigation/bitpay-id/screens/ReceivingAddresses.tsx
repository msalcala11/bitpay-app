import React from 'react';
import styled from 'styled-components/native';
import {useTheme} from '@react-navigation/native';
import {Br, HEIGHT} from '../../../components/styled/Containers';
import {
  CurrencyListIcons,
  SupportedCurrencyOptions,
} from '../../../constants/SupportedCurrencyOptions';
import {H3, H5, Paragraph} from '../../../components/styled/Text';
import {BaseText} from '../../wallet/components/KeyDropdownOption';
import {
  LightBlack,
  Slate,
  Slate10,
  Slate30,
  SlateDark,
} from '../../../styles/colors';
import AddSvg from '../../../../assets/img/add.svg';
import AddWhiteSvg from '../../../../assets/img/add-white.svg';
import {TouchableOpacity} from 'react-native-gesture-handler';
import Button from '../../../components/button/Button';
import {t} from 'i18next';
import ChevronRight from '../components/ChevronRight';

const ViewContainer = styled.View`
  padding: 16px;
  flex-direction: column;
  height: ${HEIGHT - 110}px;
`;

const ViewBody = styled.View`
  flex-grow: 1;
`;

const AddressItem = styled.View`
  align-items: center;
  border: 0.75px solid ${Slate};
  border-color: ${({theme: {dark}}) => (dark ? Slate : Slate30)};
  border-radius: 8px;
  flex-direction: row;
  padding: 12px 15px;
  margin-top: 10px;
  padding-left: 2px;
`;

const AddressItemText = styled(Paragraph)`
  flex-grow: 1;
  margin-left: 0px;
`;

const WalletName = styled(BaseText)`
  font-size: 16px;
`;

const AddButton = styled.View`
  height: 30px;
  width: 30px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Slate10)};
  border-radius: 8px;
  align-items: center;
  justify-content: center;
  margin-left: 11px;
  margin-right: 9px;
`;

const MoreCurrenciesText = styled(Paragraph)`
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
  font-size: 14px;
  margin-left: 30px;
`;

const UnusedCurrencyIcons = styled.View`
  flex-direction: row;
`;

const usedCurrencies = ['BTC', 'BCH', 'ETH'];
const unusedCurrencyOptions = SupportedCurrencyOptions.filter(
  currencyOption =>
    !usedCurrencies.includes(currencyOption.currencyAbbreviation),
);

const ReceivingAddresses = () => {
  const theme = useTheme();
  return (
    <ViewContainer>
      <ViewBody>
        <H3>Choose your BitPay ID Receiving Addresses</H3>
        <Br />
        <Paragraph>
          Decide what wallets you would like to receive to when a friend sends
          crypto to your email address. Each incoming payment will be sent to a
          newly generated address.
        </Paragraph>
        <Br />
        <Br />
        <H5>Receiving Addresses</H5>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {<CurrencyListIcons.btc height="25" />}
            <AddressItemText>
              Select a <WalletName>BTC Wallet</WalletName>
            </AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {<CurrencyListIcons.bch height="25" />}
            <AddressItemText>
              Select a <WalletName>BCH Wallet</WalletName>
            </AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {<CurrencyListIcons.eth height="25" />}
            <AddressItemText>
              Select a <WalletName>ETH Wallet</WalletName>
            </AddressItemText>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            <AddButton>{theme.dark ? <AddWhiteSvg /> : <AddSvg />}</AddButton>
            <AddressItemText>Add Wallet</AddressItemText>
            <UnusedCurrencyIcons>
              {unusedCurrencyOptions.slice(0, 3).map(currencyOption => (
                <currencyOption.img height="25" style={{marginRight: -35}} />
              ))}
              <MoreCurrenciesText>
                +{unusedCurrencyOptions.length} More
              </MoreCurrenciesText>
            </UnusedCurrencyIcons>
          </AddressItem>
        </TouchableOpacity>
      </ViewBody>
      <Button buttonStyle={'primary'} onPress={() => console.log('save')}>
        {t('Save Defaults')}
      </Button>
      <Button
        buttonStyle={'primary'}
        buttonType={'link'}
        onPress={() => console.log('save')}>
        {t('Add Custom Address')}
      </Button>
    </ViewContainer>
  );
};

export default ReceivingAddresses;
