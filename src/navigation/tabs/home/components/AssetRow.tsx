import React, {useMemo} from 'react';
import {ImageRequireSource} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import {useNavigation} from '@react-navigation/native';
import SkeletonPlaceholder from 'react-native-skeleton-placeholder';
import styled, {useTheme} from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {TouchableOpacity} from '../../../../components/base/TouchableOpacity';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {BaseText, H7} from '../../../../components/styled/Text';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {
  CharcoalBlack,
  GhostWhite,
  LightBlack,
  LightBlue,
  NeutralSlate,
  Slate30,
  SlateDark,
  White,
} from '../../../../styles/colors';
import {getDifferenceColor} from '../../../../components/percentage/Percentage';
import haptic from '../../../../components/haptic-feedback/haptic';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {maskIfHidden} from '../../../../utils/hideBalances';
import {showBottomNotificationModal} from '../../../../store/app/app.actions';
import ChevronRightSvg from './ChevronRightSvg';
import {
  AssetRowItem,
  findSupportedCurrencyOptionForAsset,
} from '../../../../utils/assets';

const Row = styled(TouchableOpacity)<{isLast: boolean}>`
  flex-direction: row;
  align-items: center;
  padding: 14px 0;
  border-bottom-width: ${({isLast}) => (isLast ? 0 : 1)}px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : LightBlue)};
`;

const IconContainer = styled.View`
  width: 40px;
  height: 40px;
  align-items: center;
  justify-content: center;
  margin-right: 12px;
`;

const AssetInfo = styled.View`
  flex: 1;
  justify-content: center;
`;

const AssetName = styled(BaseText)`
  font-size: 13px;
  font-weight: 400;
  color: ${({theme}) => theme.colors.text};
`;

const AssetAmount = styled(H7)`
  margin-top: 2px;
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const Values = styled.View`
  align-items: flex-end;
  justify-content: center;
  margin-right: 12px;
`;

const FiatAmount = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme}) => theme.colors.text};
`;

const DeltaFiat = styled(BaseText)<{isPositive: boolean}>`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}, isPositive}) =>
    getDifferenceColor(isPositive, dark)};
`;

const PercentPill = styled.View`
  border-radius: 50px;
  padding: 8px 10px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
  margin-right: 14px;
`;

const PercentText = styled(BaseText)<{isPositive: boolean}>`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}, isPositive}) =>
    getDifferenceColor(isPositive, dark)};
`;

const ChevronContainer = styled.View<{visible: boolean}>`
  width: 9px;
  align-items: flex-end;
  opacity: ${({visible}) => (visible ? 1 : 0)};
`;

interface Props {
  item: AssetRowItem;
  isLast: boolean;
  isExchangeRateSupported: boolean;
  isFiatLoading?: boolean;
  isPopulateLoading?: boolean;
  onPress?: () => void;
}

const AssetRow: React.FC<Props> = ({
  item,
  isLast,
  isExchangeRateSupported,
  isFiatLoading,
  isPopulateLoading,
  onPress,
}) => {
  const navigation = useNavigation();
  const theme = useTheme();
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);
  const hasRate = !!item.hasRate;
  const isPressEnabled = isExchangeRateSupported && hasRate;
  const canCopyLog = !!item.pnlLog;
  const isTouchable = isPressEnabled || canCopyLog;
  const option = useMemo(() => {
    return findSupportedCurrencyOptionForAsset({
      options: SupportedCurrencyOptions,
      currencyAbbreviation: item.currencyAbbreviation,
      chain: item.chain,
      tokenAddress: item.tokenAddress,
    });
  }, [item.chain, item.currencyAbbreviation, item.tokenAddress]);

  const handleLongPress = () => {
    if (!item.pnlLog) {
      return;
    }
    haptic('impactLight');
    try {
      Clipboard.setString(JSON.stringify(item.pnlLog, null, 2));
    } catch (e) {
      // Fallback in case the log contains unexpected unserializable values.
      Clipboard.setString(String(item.pnlLog));
    }
    dispatch(
      showBottomNotificationModal({
        type: 'success',
        title: t('Copied!'),
        message: t('PnL calculation log copied to clipboard'),
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('OK'),
            action: () => null,
            primary: true,
          },
        ],
      }),
    );
  };

  const handlePress = () => {
    if (!isPressEnabled) {
      return;
    }

    if (onPress) {
      onPress();
      return;
    }

    (navigation as any).navigate('ExchangeRate', {
      currencyName: option?.currencyName || item.name,
      currencyAbbreviation:
        option?.currencyAbbreviation || item.currencyAbbreviation,
      chain: option?.chain || item.chain,
      tokenAddress: option?.tokenAddress || item.tokenAddress,
    });
  };

  return (
    <Row
      activeOpacity={isTouchable ? ActiveOpacity : 1}
      isLast={isLast}
      delayLongPress={canCopyLog ? 10000 : undefined}
      onLongPress={canCopyLog ? handleLongPress : undefined}
      onPress={isPressEnabled ? handlePress : undefined}>
      <IconContainer>
        <CurrencyImage
          img={option?.img}
          imgSrc={option?.imgSrc as ImageRequireSource}
          size={40}
        />
      </IconContainer>

      <AssetInfo>
        <AssetName numberOfLines={1} ellipsizeMode="tail">
          {item.name}
        </AssetName>
        {hideAllBalances ? (
          <AssetAmount>{maskIfHidden(true, item.cryptoAmount)}</AssetAmount>
        ) : isPopulateLoading ? (
          <SkeletonPlaceholder
            backgroundColor={theme.dark ? CharcoalBlack : NeutralSlate}
            highlightColor={theme.dark ? LightBlack : GhostWhite}>
            <SkeletonPlaceholder.Item
              width={80}
              height={12}
              borderRadius={2}
              marginTop={4}
            />
          </SkeletonPlaceholder>
        ) : (
          <AssetAmount>{item.cryptoAmount}</AssetAmount>
        )}
      </AssetInfo>

      {hasRate ? (
        <>
          <Values>
            {hideAllBalances ? (
              <>
                <FiatAmount>{maskIfHidden(true, item.fiatAmount)}</FiatAmount>
                <DeltaFiat isPositive={item.isPositive}>
                  {maskIfHidden(true, item.deltaFiat)}
                </DeltaFiat>
              </>
            ) : isFiatLoading || isPopulateLoading ? (
              <SkeletonPlaceholder
                backgroundColor={theme.dark ? CharcoalBlack : NeutralSlate}
                highlightColor={theme.dark ? LightBlack : GhostWhite}>
                <SkeletonPlaceholder.Item
                  width={72}
                  height={12}
                  borderRadius={2}
                  marginBottom={6}
                />
                <SkeletonPlaceholder.Item
                  width={54}
                  height={12}
                  borderRadius={2}
                />
              </SkeletonPlaceholder>
            ) : (
              <>
                <FiatAmount>{item.fiatAmount}</FiatAmount>
                <DeltaFiat isPositive={item.isPositive}>
                  {item.deltaFiat}
                </DeltaFiat>
              </>
            )}
          </Values>

          <PercentPill>
            {isFiatLoading || isPopulateLoading ? (
              <SkeletonPlaceholder
                backgroundColor={theme.dark ? CharcoalBlack : NeutralSlate}
                highlightColor={theme.dark ? LightBlack : GhostWhite}>
                <SkeletonPlaceholder.Item
                  width={48}
                  height={12}
                  borderRadius={2}
                />
              </SkeletonPlaceholder>
            ) : (
              <PercentText isPositive={item.isPositive}>
                {item.deltaPercent}
              </PercentText>
            )}
          </PercentPill>
        </>
      ) : null}

      <ChevronContainer visible={isPressEnabled}>
        <ChevronRightSvg width={9} height={15} gray />
      </ChevronContainer>
    </Row>
  );
};

export default AssetRow;
