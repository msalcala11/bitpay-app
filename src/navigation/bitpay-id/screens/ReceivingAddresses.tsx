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
import SendToPill from '../../wallet/components/SendToPill';

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
  height: 55px;
  padding: 0 15px;
  margin-top: 10px;
  padding-left: 2px;
`;

const AddressItemText = styled(Paragraph)`
  flex-grow: 1;
  margin-left: 0px;
`;

const AddressPillContainer = styled.View`
  height: 37px;
  margin-right: 20px;
  width: 100px;
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
`;

const UnusedCurrencies = styled.View`
  flex-direction: row;
`;

const UnusedCurrencyIcons = styled.View`
  flex-direction: row;
  margin-right: 30px;
`;

const usedCurrencies = ['BTC', 'BCH', 'ETH'];
const unusedCurrencyOptions = SupportedCurrencyOptions.filter(
  currencyOption =>
    !usedCurrencies.includes(currencyOption.currencyAbbreviation),
);
const numVisibleCurrencyIcons = 3;

const ReceivingAddresses = () => {
  const theme = useTheme();
  return (
    <ViewContainer>
      <ViewBody>
        <H3>{t('Choose your BitPay ID Receiving Addresses')}</H3>
        <Br />
        <Paragraph>
          {t(
            'Decide what wallets you would like to receive to when a friend sends crypto to your email address. Each incoming payment will be sent to a newly generated address.',
          )}
        </Paragraph>
        <Br />
        <Br />
        <H5>{t('Active Addresses')}</H5>
        <TouchableOpacity activeOpacity={0.8}>
          <AddressItem>
            {<CurrencyListIcons.bch height="25" />}
            <AddressItemText>
              <WalletName>BeCash</WalletName>
            </AddressItemText>
            <AddressPillContainer>
              <SendToPill
                accent="action"
                onPress={() => console.log('hi')}
                description={'qzv4c2gufsgqmctv4e4u6mvmkhftmv38cg3jrxynmy'}
              />
            </AddressPillContainer>
            <ChevronRight />
          </AddressItem>
        </TouchableOpacity>
        <Br />
        <H5>{t('Receiving Addresses')}</H5>
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
            <AddressItemText>{t('Add Wallet')}</AddressItemText>
            <UnusedCurrencies>
              <UnusedCurrencyIcons>
                {unusedCurrencyOptions
                  .slice(0, numVisibleCurrencyIcons)
                  .map(currencyOption => (
                    <currencyOption.img
                      height="25"
                      style={{marginRight: -35}}
                    />
                  ))}
              </UnusedCurrencyIcons>
              {unusedCurrencyOptions.length > numVisibleCurrencyIcons ? (
                <MoreCurrenciesText>
                  +{unusedCurrencyOptions.length - numVisibleCurrencyIcons} More
                </MoreCurrenciesText>
              ) : null}
            </UnusedCurrencies>
          </AddressItem>
        </TouchableOpacity>
      </ViewBody>
      <Button buttonStyle={'primary'} onPress={() => console.log('save')}>
        {t('Save Defaults')}
      </Button>
      <Br />
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
