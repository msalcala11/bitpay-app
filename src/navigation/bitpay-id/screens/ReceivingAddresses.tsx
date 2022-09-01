import React, {useState} from 'react';
import styled from 'styled-components/native';
import {useNavigation, useTheme} from '@react-navigation/native';
import _ from 'lodash';
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
import {BitpayIdScreens} from '../BitpayIdStack';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {BuildKeysAndWalletsList} from '../../../store/wallet/utils/wallet';
import {Network} from '../../../constants';
import {WalletSelector} from '../../wallet/screens/send/confirm/Shared';
import { KeyWallet } from '../../../components/list/KeyWalletsRow';

const ViewContainer = styled.ScrollView`
  padding: 16px;
  flex-direction: column;
  height: ${HEIGHT - 110}px;
`;

const ViewBody = styled.View`
  flex-grow: 1;
  padding-bottom: 20px;
`;

const SectionHeader = styled(H5)`
  margin-top: 20px;
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

const numVisibleCurrencyIcons = 3;

const ReceivingAddresses = () => {
  const dispatch = useAppDispatch();
  const navigation = useNavigation();
  const theme = useTheme();
  const keys = useAppSelector(({WALLET}) => WALLET.keys);
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const [walletSelectorVisible, setWalletSelectorVisible] = useState(false);
  const [walletSelectCurrency, setWalletSelectorCurrency] = useState('btc');
  const uniqueActiveCurrencies = _.uniq(
    Object.values(keys)
      .flatMap(key => key.wallets)
      .filter(wallet => wallet.network === Network.mainnet)
      .map(wallet => wallet.currencyAbbreviation),
  );
  const unusedCurrencyOptions = SupportedCurrencyOptions.filter(
    currencyOption =>
      !uniqueActiveCurrencies.includes(
        currencyOption.currencyAbbreviation.toLowerCase(),
      ),
  );
  console.log('zzz uniqueCurrencies', uniqueActiveCurrencies);
  const keyWallets = BuildKeysAndWalletsList({
    keys,
    network: Network.mainnet,
    defaultAltCurrencyIsoCode: 'USD',
    rates,
    dispatch,
  });

  const keyWalletsByCurrency = uniqueActiveCurrencies.reduce(
    (keyWalletMap, currency) => ({
      ...keyWalletMap,
      [currency]: keyWallets.map(keyWallet => ({
        ...keyWallet,
        wallets: keyWallet.wallets.filter(
          wallet => wallet.currencyAbbreviation === walletSelectCurrency,
        ),
      })),
    }),
    {} as {[key: string]: any[]},
  );

  console.log('zzz keyWallets', keyWallets);
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
        <SectionHeader>{t('Active Addresses')}</SectionHeader>
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
        <SectionHeader>{t('Receiving Addresses')}</SectionHeader>
        {uniqueActiveCurrencies.map(currencyAbbreviation => {
          const CurrencyIcon = CurrencyListIcons[currencyAbbreviation];
          return (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                setWalletSelectorCurrency(currencyAbbreviation);
                setWalletSelectorVisible(true);
              }}>
              <AddressItem>
                <CurrencyIcon height="25" />
                <AddressItemText>
                  Select a{' '}
                  <WalletName>
                    {currencyAbbreviation.toUpperCase()} Wallet
                  </WalletName>
                </AddressItemText>
                <ChevronRight />
              </AddressItem>
            </TouchableOpacity>
          );
        })}
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
      <Button
        buttonStyle={'primary'}
        onPress={() => {
          navigation.navigate('BitpayId', {
            screen: BitpayIdScreens.RECEIVING_ENABLED,
          });
        }}>
        {t('Save Defaults')}
      </Button>
      <Br />
      <Button
        buttonStyle={'primary'}
        buttonType={'link'}
        onPress={() => console.log('save')}>
        {t('Add Custom Address')}
      </Button>

      <WalletSelector
        isVisible={walletSelectorVisible}
        setWalletSelectorVisible={setWalletSelectorVisible}
        walletsAndAccounts={{
          keyWallets: keyWalletsByCurrency[walletSelectCurrency],
          coinbaseWallets: [],
        }}
        onWalletSelect={() => console.log('hi')}
        onCoinbaseAccountSelect={() => console.log('noop')}
        onBackdropPress={async () => {
          setWalletSelectorVisible(false);
        }}
      />
    </ViewContainer>
  );
};

export default ReceivingAddresses;
