import React, {useEffect, useState} from 'react';
import _ from 'lodash';
import styled from 'styled-components/native';
import {useNavigation, useTheme} from '@react-navigation/native';
import {ActiveOpacity, Br, CtaContainerAbsolute} from '../../../components/styled/Containers';
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
import {createWalletAddress} from '../../../store/wallet/effects/address/address';
import {startOnGoingProcessModal} from '../../../store/app/app.effects';
import {OnGoingProcessMessages} from '../../../components/modal/ongoing-process/OngoingProcess';
import {dismissOnGoingProcessModal} from '../../../store/app/app.actions';
import {APP_NETWORK} from '../../../constants/config';
import {CustomErrorMessage} from '../../wallet/components/ErrorMessages';
import {AppActions} from '../../../store/app';
import {Wallet} from '../../../store/wallet/wallet.models';
import {sleep} from '../../../utils/helper-methods';
import {BitPayIdEffects} from '../../../store/bitpay-id';
import {ReceivingAddress} from '../../../store/bitpay-id/bitpay-id.models';

const ViewContainer = styled.ScrollView`
  padding: 16px;
  flex-direction: column;
`;

const ViewBody = styled.View`
  flex-grow: 1;
  padding-bottom: 150px;
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

const FooterButton = styled(CtaContainerAbsolute)`
  box-shadow: 0px 4px 12px rgba(0, 0, 0, 0.1);
`;

const numVisibleCurrencyIcons = 3;

const createAddressMap = (receivingAddresses: ReceivingAddress[]) => {
  return _.keyBy(receivingAddresses, address => address.currency.toLowerCase());
};

const ReceivingAddresses = () => {
  const dispatch = useAppDispatch();
  const navigation = useNavigation();
  const theme = useTheme();
  const keys = useAppSelector(({WALLET}) => WALLET.keys);
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const apiToken = useAppSelector(
    ({BITPAY_ID}) => BITPAY_ID.apiToken[APP_NETWORK],
  );
  const receivingAddresses = useAppSelector(
    ({BITPAY_ID}) => BITPAY_ID.receivingAddresses[APP_NETWORK],
  );
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const [walletSelectorVisible, setWalletSelectorVisible] = useState(false);
  const [walletSelectCurrency, setWalletSelectorCurrency] = useState('btc');
  console.log('zzz initial addresses', receivingAddresses);
  const [activeAddresses, setActiveAddresses] = useState<
    _.Dictionary<ReceivingAddress>
  >({});
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
  const keyWallets = BuildKeysAndWalletsList({
    keys,
    network: Network.mainnet,
    defaultAltCurrencyIsoCode: defaultAltCurrency.isoCode,
    rates,
    dispatch,
  });
  const unusedActiveCurrencies = uniqueActiveCurrencies.filter(
    currencyAbbreviation =>
      !Object.keys(activeAddresses).includes(currencyAbbreviation),
  );
  const keyWalletsByCurrency = uniqueActiveCurrencies.reduce(
    (keyWalletMap, currency) => ({
      ...keyWalletMap,
      [currency]: keyWallets
        .map(keyWallet => ({
          ...keyWallet,
          wallets: keyWallet.wallets.filter(
            wallet => wallet.currencyAbbreviation === walletSelectCurrency,
          ),
        }))
        .filter(keyWallet => keyWallet.wallets.length),
    }),
    {} as {[key: string]: any[]},
  );

  const showError = ({
    error,
    defaultErrorMessage,
    onDismiss,
  }: {
    error?: any;
    defaultErrorMessage: string;
    onDismiss?: () => Promise<void>;
  }) => {
    dispatch(
      AppActions.showBottomNotificationModal(
        CustomErrorMessage({
          title: t('Error'),
          errMsg: error?.message || defaultErrorMessage,
          action: () => onDismiss && onDismiss(),
        }),
      ),
    );
  };

  const generateAddress = async (wallet: Wallet) => {
    dispatch(
      startOnGoingProcessModal(t(OnGoingProcessMessages.GENERATING_ADDRESS)),
    );
    let address = await dispatch(
      createWalletAddress({wallet, newAddress: true}),
    );
    if (wallet.currencyAbbreviation === 'bch') {
      address = 'qqcf5vkh3f7rg4yd6njyeaaa23njc70cdqrt94ypls';
    }
    await dispatch(dismissOnGoingProcessModal());
    setActiveAddresses({
      ...activeAddresses,
      [wallet.currencyAbbreviation]: {
        id: '',
        label: wallet.walletName || wallet.currencyAbbreviation.toUpperCase(),
        address,
        provider: 'BitPay',
        currency: wallet.currencyAbbreviation.toUpperCase(),
        status: {
          isActive: true,
        },
        usedFor: {
          payToEmail: true,
        },
      },
    });
  };

  const saveAddresses = async () => {
    dispatch(
      startOnGoingProcessModal(t(OnGoingProcessMessages.SAVING_ADDRESSES)),
    );
    const newReceivingAddresses = Object.values(activeAddresses);
    await dispatch(
      BitPayIdEffects.startUpdateReceivingAddresses(newReceivingAddresses),
    );
    await dispatch(dismissOnGoingProcessModal());
    navigation.navigate('BitpayId', {
      screen: BitpayIdScreens.RECEIVING_ENABLED,
    });
  };

  useEffect(() => {
    setActiveAddresses(createAddressMap(receivingAddresses));
    const getWallets = async () => {
      const latestReceivingAddresses = await dispatch(
        BitPayIdEffects.startFetchReceivingAddresses(),
      );
      setActiveAddresses(createAddressMap(latestReceivingAddresses));
    };
    getWallets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiToken, dispatch]);

  return (
    <>
      <ViewContainer>
        <ViewBody>
          <H3>{t('Choose your Primary Wallet to Receive Payments')}</H3>
          <Br />
          <Paragraph>
            {t(
              "Decide which wallets you'd like to receive funds when crypto is sent to your email address.",
            )}
          </Paragraph>
          {Object.keys(activeAddresses).length ? (
            <>
              <SectionHeader>{t('Active Addresses')}</SectionHeader>
              {Object.keys(activeAddresses).map(currencyAbbreviation => {
                const activeAddress = activeAddresses[currencyAbbreviation];
                const CurrencyIcon = CurrencyListIcons[currencyAbbreviation];
                return (
                  <TouchableOpacity
                    activeOpacity={ActiveOpacity}
                    key={activeAddress.currency}
                    onPress={() => {
                      delete activeAddresses[
                        activeAddress.currency.toLowerCase()
                      ];
                      console.log('zzz activeAddresses', activeAddresses);
                      setActiveAddresses({...activeAddresses});
                    }}>
                    <AddressItem>
                      <CurrencyIcon height="25" />
                      <AddressItemText>
                        <WalletName>{activeAddress.label}</WalletName>
                      </AddressItemText>
                      <AddressPillContainer>
                        <SendToPill
                          accent="action"
                          onPress={() => console.log('hi')}
                          description={activeAddress.address}
                        />
                      </AddressPillContainer>
                      <ChevronRight />
                    </AddressItem>
                  </TouchableOpacity>
                );
              })}
            </>
          ) : null}
          {unusedActiveCurrencies.length + unusedCurrencyOptions.length > 0 ? (
            <>
              <SectionHeader>{t('Receiving Addresses')}</SectionHeader>
              {unusedActiveCurrencies.map(currencyAbbreviation => {
                const CurrencyIcon = CurrencyListIcons[currencyAbbreviation];
                return (
                  <TouchableOpacity
                    activeOpacity={ActiveOpacity}
                    key={currencyAbbreviation}
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
              <TouchableOpacity
                activeOpacity={ActiveOpacity}
                onPress={() => {
                  const keyList = Object.values(keys);
                  if (keyList.length === 1) {
                    navigation.navigate('Wallet', {
                      screen: 'AddingOptions',
                      params: {
                        key: keyList[0],
                      },
                    });
                    return;
                  }
                  navigation.navigate('Wallet', {
                    screen: 'KeyGlobalSelect',
                    params: {
                      context: 'join',
                      // invitationCode: data,
                    },
                  });
                }}>
                <AddressItem>
                  <AddButton>
                    {theme.dark ? <AddWhiteSvg /> : <AddSvg />}
                  </AddButton>
                  <AddressItemText>{t('Add Wallet')}</AddressItemText>
                  <UnusedCurrencies>
                    <UnusedCurrencyIcons>
                      {unusedCurrencyOptions
                        .slice(0, numVisibleCurrencyIcons)
                        .map(currencyOption => (
                          <currencyOption.img
                            key={currencyOption.currencyAbbreviation}
                            height="25"
                            style={{marginRight: -35}}
                          />
                        ))}
                    </UnusedCurrencyIcons>
                    {unusedCurrencyOptions.length > numVisibleCurrencyIcons ? (
                      <MoreCurrenciesText>
                        +
                        {unusedCurrencyOptions.length - numVisibleCurrencyIcons}{' '}
                        More
                      </MoreCurrenciesText>
                    ) : null}
                  </UnusedCurrencies>
                </AddressItem>
              </TouchableOpacity>
            </>
          ) : null}
        </ViewBody>
        {/* <Button buttonStyle={'primary'} onPress={() => saveAddresses()}>
          {t('Save Defaults')}
        </Button>
        <Br />
        <Button
          buttonStyle={'primary'}
          buttonType={'link'}
          onPress={() => console.log('save')}>
          {t('Add Custom Address')}
        </Button> */}
        <WalletSelector
          isVisible={walletSelectorVisible}
          setWalletSelectorVisible={setWalletSelectorVisible}
          autoSelectIfOnlyOneWallet={false}
          currency={walletSelectCurrency}
          walletsAndAccounts={{
            keyWallets: keyWalletsByCurrency[walletSelectCurrency],
            coinbaseWallets: [],
          }}
          onWalletSelect={async wallet => {
            await generateAddress(wallet).catch(async error => {
              await dispatch(dismissOnGoingProcessModal());
              await sleep(400);
              showError({error, defaultErrorMessage: 'Could not save address'});
            });
          }}
          onCoinbaseAccountSelect={() => {}}
          onBackdropPress={async () => {
            setWalletSelectorVisible(false);
          }}
        />
      </ViewContainer>
      <FooterButton
        background={true}
        style={{
          shadowColor: '#000',
          shadowOffset: {width: 0, height: 4},
          shadowOpacity: 0.1,
          shadowRadius: 12,
          elevation: 5,
        }}>
        <Button onPress={() => saveAddresses()} buttonStyle={'primary'}>
          {t('Save Defaults')}
        </Button>
        <Br />
        {/* <Button
          buttonStyle={'primary'}
          buttonType={'link'}
          onPress={() => console.log('save')}>
          {t('Add Custom Address')}
        </Button> */}
      </FooterButton>
    </>
  );
};

export default ReceivingAddresses;
