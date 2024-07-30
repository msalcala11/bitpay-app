import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import GlobalSelect, {
  GlobalSelectModalContext,
} from '../../../wallet/screens/GlobalSelect';
import {Black, LightBlack, White} from '../../../../styles/colors';
import styled from 'styled-components/native';
import SheetModal from '../../../../components/modal/base/sheet/SheetModal';
import {Platform, ScrollView} from 'react-native';
import {
  Column,
  CurrencyImageContainer,
} from '../../../../components/styled/Containers';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {H4, H5, SubText, TextAlign} from '../../../../components/styled/Text';
import {SwapCryptoCoin} from '../screens/SwapCryptoRoot';
import {getBadgeImg} from '../../../../utils/helper-methods';
import {SellCryptoCoin} from '../../sell-crypto/screens/SellCryptoRoot';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

const GlobalSelectContainer = styled.View`
  flex: 1;
  background-color: ${({theme: {dark}}) => (dark ? Black : White)};
`;

const SwapCryptoHelpContainer = styled.View`
  padding: 20px 15px 0px 15px;
  background: ${({theme: {dark}}) => (dark ? LightBlack : White)};
  border-top-left-radius: 12px;
  border-top-right-radius: 12px;
  height: 75%;
`;

const RowContainer = styled.View`
  flex-direction: row;
  align-items: center;
  margin-top: 10px;
  margin-bottom: 10px;
`;

export const CurrencyColumn = styled(Column)`
  margin-left: 8px;
`;
interface FromWalletSelectorModalProps {
  isVisible: boolean;
  customSupportedCurrencies?: SwapCryptoCoin[] | SellCryptoCoin[];
  livenetOnly?: boolean;
  onDismiss: (toWallet?: any) => void;
  modalContext?: GlobalSelectModalContext;
  modalTitle?: string;
}

const FromWalletSelectorModal: React.FC<FromWalletSelectorModalProps> = ({
  isVisible,
  customSupportedCurrencies,
  livenetOnly,
  onDismiss,
  modalContext,
  modalTitle,
}) => {
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();
  const [swapCryptoHelpVisible, setSwapCryptoHelpVisible] = useState(false);

  const _customSupportedCurrencies = customSupportedCurrencies?.map(
    ({symbol}) => symbol,
  );

  const onHelpPress = () => {
    setSwapCryptoHelpVisible(true);
  };

  return (
    <SheetModal
      isVisible={isVisible}
      onBackdropPress={() => onDismiss(undefined)}>
      <GlobalSelectContainer
        style={Platform.OS === 'ios' ? {paddingTop: insets.top} : {}}>
        <GlobalSelect
          useAsModal={true}
          modalTitle={modalTitle}
          customSupportedCurrencies={_customSupportedCurrencies}
          globalSelectOnDismiss={onDismiss}
          modalContext={modalContext}
          livenetOnly={livenetOnly}
          onHelpPress={onHelpPress}
          selectingNetworkForDeposit={false}
        />

        <SheetModal
          isVisible={swapCryptoHelpVisible}
          onBackdropPress={() => setSwapCryptoHelpVisible(false)}>
          <SwapCryptoHelpContainer>
            <TextAlign align={'center'}>
              {modalContext === 'swapFrom' ? (
                <H4>{t('What can I swap?')}</H4>
              ) : null}
              {modalContext === 'sell' ? (
                <H4>{t('What can I sell?')}</H4>
              ) : null}
            </TextAlign>
            <TextAlign align={'center'}>
              {modalContext === 'swapFrom' ? (
                <SubText>{t('swapFromWalletsConditionMessage')}</SubText>
              ) : null}
              {modalContext === 'sell' ? (
                <SubText>
                  {t(
                    'Below are the available coins/tokens that you can sell from. If you are not able to see some of your wallets, remember that your key must be backed up and have funds not locked due to pending transactions.',
                  )}
                </SubText>
              ) : null}
            </TextAlign>
            <ScrollView style={{marginTop: 20}}>
              {customSupportedCurrencies?.map((currency, index) => (
                <RowContainer key={index}>
                  <CurrencyImageContainer>
                    <CurrencyImage
                      img={currency.logoUri}
                      badgeUri={getBadgeImg(
                        currency.currencyAbbreviation,
                        currency.chain,
                      )}
                    />
                  </CurrencyImageContainer>
                  <CurrencyColumn>
                    <H5>{currency.name}</H5>
                    {currency?.currencyAbbreviation ? (
                      <SubText>
                        {currency.currencyAbbreviation.toUpperCase()}
                      </SubText>
                    ) : null}
                  </CurrencyColumn>
                </RowContainer>
              ))}
            </ScrollView>
          </SwapCryptoHelpContainer>
        </SheetModal>
      </GlobalSelectContainer>
    </SheetModal>
  );
};

export default FromWalletSelectorModal;
