import React, {useCallback, useMemo, useRef} from 'react';
import {ImageRequireSource} from 'react-native';
import {NavigationProp, useNavigation} from '@react-navigation/native';
import SkeletonPlaceholder from 'react-native-skeleton-placeholder';
import styled, {useTheme} from 'styled-components/native';
import type {RootStackParamList} from '../../../../Root';
import Clipboard from '@react-native-clipboard/clipboard';
import {
  FIAT_RATE_SERIES_CACHED_INTERVALS,
  FIAT_RATE_SERIES_TARGET_POINTS,
  getFiatRateSeriesCacheKey,
} from '../../../../store/rate/rate.models';
import {TouchableOpacity} from '../../../../components/base/TouchableOpacity';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {ActiveOpacity} from '../../../../components/styled/Containers';
import {BaseText, H7} from '../../../../components/styled/Text';
import {showBottomNotificationModal} from '../../../../store/app/app.actions';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {BitpaySupportedCoins, BitpaySupportedTokens} from '../../../../constants/currencies';
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
import {getCurrencyAbbreviation} from '../../../../utils/helper-methods';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {maskIfHidden} from '../../../../utils/hideBalances';
import ChevronRightSvg from './ChevronRightSvg';
import {
  AssetRowItem,
  canNavigateToExchangeRateForAssetRowItem,
} from '../../../../utils/portfolio/assets';
import {normalizeFiatRateSeriesCoin} from '../../../../utils/portfolio/core/pnl/rates';
import {createSupportedCurrencyOptionLookup} from '../../../../utils/portfolio/supportedCurrencyOptionsLookup';

const supportedCurrencyOptionLookup = createSupportedCurrencyOptionLookup(
  SupportedCurrencyOptions,
);

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

const DeltaFiat = styled(BaseText)<{isPositive: boolean; hasPnl: boolean}>`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}, isPositive, hasPnl}) =>
    hasPnl ? getDifferenceColor(isPositive, dark) : dark ? Slate30 : SlateDark};
`;

const PercentPill = styled.View`
  border-radius: 50px;
  padding: 8px 10px;
  border: 1px solid ${({theme: {dark}}) => (dark ? SlateDark : Slate30)};
  background-color: ${({theme: {dark}}) => (dark ? 'transparent' : White)};
  margin-right: 14px;
`;

const PercentText = styled(BaseText)<{isPositive: boolean; hasPnl: boolean}>`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}, isPositive, hasPnl}) =>
    hasPnl ? getDifferenceColor(isPositive, dark) : dark ? Slate30 : SlateDark};
`;

const ChevronContainer = styled.View<{visible: boolean}>`
  width: 9px;
  align-items: flex-end;
  opacity: ${({visible}) => (visible ? 1 : 0)};
`;

interface Props {
  item: AssetRowItem;
  isLast: boolean;
  isFiatLoading?: boolean;
  isPopulateLoading?: boolean;
}

const AssetRow: React.FC<Props> = ({
  item,
  isLast,
  isFiatLoading,
  isPopulateLoading,
}) => {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const dispatch = useAppDispatch();
  const theme = useTheme();
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );
  const option = useMemo(() => {
    return supportedCurrencyOptionLookup.getOption({
      currencyAbbreviation: item.currencyAbbreviation,
      chain: item.chain,
      tokenAddress: item.tokenAddress,
    });
  }, [item.chain, item.currencyAbbreviation, item.tokenAddress]);
  const hasRate = !!item.hasRate;
  const hasPnl = !!item.hasPnl;
  const showPnlPlaceholder = !!item.showPnlPlaceholder;
  const shouldShowRightSide = hasRate || showPnlPlaceholder;
  const suppressNextPressRef = useRef(false);
  const itemAbbrLower = (item.currencyAbbreviation || '').toLowerCase();
  const isUsdtRow = itemAbbrLower === 'usdt';
  const hasHistoricalV4Rates = useMemo(() => {
    const fiatCodeUpper = (defaultAltCurrency?.isoCode || 'USD').toUpperCase();
    const normalizedCoin = normalizeFiatRateSeriesCoin(item.currencyAbbreviation);
    if (!normalizedCoin) {
      return false;
    }

    for (const interval of FIAT_RATE_SERIES_CACHED_INTERVALS) {
      const cacheKey = getFiatRateSeriesCacheKey(
        fiatCodeUpper,
        normalizedCoin,
        interval,
      );
      const pointsLength = fiatRateSeriesCache?.[cacheKey]?.points?.length || 0;
      if (pointsLength < FIAT_RATE_SERIES_TARGET_POINTS) {
        return false;
      }
    }

    return true;
  }, [defaultAltCurrency?.isoCode, fiatRateSeriesCache, item.currencyAbbreviation]);
  const canNavigate = useMemo(() => {
    return (
      hasHistoricalV4Rates &&
      canNavigateToExchangeRateForAssetRowItem({
        item,
        options: option ? [option] : [],
      })
    );
  }, [hasHistoricalV4Rates, item, option]);
  const shouldShowDeltaFiat = hasPnl;
  const isCryptoAmountLoading = !!isPopulateLoading && !isFiatLoading;

  const fiatAmountDisplay = hasRate ? item.fiatAmount : '— ';

  const getUsdtNavigationDebugPayload = useCallback((): string => {
    const fiatCodeUpper = (defaultAltCurrency?.isoCode || 'USD').toUpperCase();
    const normalizedCoin = normalizeFiatRateSeriesCoin(item.currencyAbbreviation);

    const cacheIntervals = FIAT_RATE_SERIES_CACHED_INTERVALS.map(interval => {
      const cacheKey = getFiatRateSeriesCacheKey(
        fiatCodeUpper,
        normalizedCoin,
        interval,
      );
      const series = fiatRateSeriesCache?.[cacheKey];
      return {
        interval,
        cacheKey,
        pointsLength: series?.points?.length || 0,
        fetchedOn: series?.fetchedOn || null,
      };
    });

    const optionExactMatch = !!(
      option &&
      (option.currencyAbbreviation || '').toLowerCase() === itemAbbrLower &&
      (option.chain || '').toLowerCase() === (item.chain || '').toLowerCase() &&
      (option.tokenAddress || '').toLowerCase() ===
        (item.tokenAddress || '').toLowerCase()
    );

    const helperCanNavigate = canNavigateToExchangeRateForAssetRowItem({
      item,
      options: option ? [option] : [],
    });

    const usdtCatalogOptions = SupportedCurrencyOptions.filter(
      o => (o.currencyAbbreviation || '').toLowerCase() === 'usdt',
    ).map(o => ({
      chain: o.chain,
      tokenAddress: o.tokenAddress || '',
    }));

    const tokenAddressLower = (item.tokenAddress || '').toLowerCase();
    const exactSupportedOption = SupportedCurrencyOptions.find(
      o =>
        (o.currencyAbbreviation || '').toLowerCase() === itemAbbrLower &&
        (o.chain || '').toLowerCase() === (item.chain || '').toLowerCase() &&
        (o.tokenAddress || '').toLowerCase() === tokenAddressLower,
    );
    const chainSupportedOption = SupportedCurrencyOptions.find(
      o =>
        (o.currencyAbbreviation || '').toLowerCase() === itemAbbrLower &&
        (o.chain || '').toLowerCase() === (item.chain || '').toLowerCase(),
    );
    const tokenSupportedOption = tokenAddressLower
      ? SupportedCurrencyOptions.find(
          o =>
            (o.currencyAbbreviation || '').toLowerCase() === itemAbbrLower &&
            (o.tokenAddress || '').toLowerCase() === tokenAddressLower,
        )
      : undefined;

    const optionCurrencyName = option
      ? getCurrencyAbbreviation(
          option.tokenAddress ? option.tokenAddress : option.currencyAbbreviation,
          option.chain,
        )
      : '';
    const optionIsStable = option
      ? !!(
          BitpaySupportedCoins[optionCurrencyName]?.properties?.isStableCoin ||
          BitpaySupportedTokens[optionCurrencyName]?.properties?.isStableCoin
        )
      : false;

    const reasons: string[] = [];
    if (!hasRate) {
      reasons.push('item.hasRate=false');
    }
    if (!option) {
      reasons.push('supported option lookup returned undefined');
    }
    if (option && !optionExactMatch) {
      reasons.push('lookup option does not exactly match item chain/tokenAddress');
    }
    if (!hasHistoricalV4Rates) {
      reasons.push('missing fiatRateSeriesCache ALL points');
    }
    if (!helperCanNavigate) {
      reasons.push('canNavigateToExchangeRateForAssetRowItem returned false');
    }
    if (!canNavigate) {
      reasons.push('final canNavigate is false');
    }

    return JSON.stringify(
      {
        type: 'ASSET_ROW_USDT_NAV_DEBUG',
        generatedAtIso: new Date().toISOString(),
        item: {
          key: item.key,
          currencyAbbreviation: item.currencyAbbreviation,
          chain: item.chain,
          tokenAddress: item.tokenAddress || '',
          hasRate,
          hasPnl,
          showPnlPlaceholder,
        },
        lookup: {
          option: option
            ? {
                currencyAbbreviation: option.currencyAbbreviation,
                chain: option.chain,
                tokenAddress: option.tokenAddress || '',
              }
            : null,
          optionExactMatch,
          optionIsStable,
          exactSupportedOption: exactSupportedOption
            ? {
                chain: exactSupportedOption.chain,
                tokenAddress: exactSupportedOption.tokenAddress || '',
              }
            : null,
          chainSupportedOption: chainSupportedOption
            ? {
                chain: chainSupportedOption.chain,
                tokenAddress: chainSupportedOption.tokenAddress || '',
              }
            : null,
          tokenSupportedOption: tokenSupportedOption
            ? {
                chain: tokenSupportedOption.chain,
                tokenAddress: tokenSupportedOption.tokenAddress || '',
              }
            : null,
          usdtCatalogOptions,
        },
        navigation: {
          helperCanNavigate,
          hasHistoricalV4Rates,
          finalCanNavigate: canNavigate,
        },
        ratesCache: {
          fiatCodeUpper,
          normalizedCoin,
          intervals: cacheIntervals,
        },
        reasons,
      },
      null,
      2,
    );
  }, [
    canNavigate,
    defaultAltCurrency?.isoCode,
    fiatRateSeriesCache,
    hasHistoricalV4Rates,
    hasPnl,
    hasRate,
    item,
    itemAbbrLower,
    option,
    showPnlPlaceholder,
  ]);

  const handleUsdtLongPress = useCallback(() => {
    if (!isUsdtRow) {
      return;
    }

    suppressNextPressRef.current = true;
    const payload = getUsdtNavigationDebugPayload();
    Clipboard.setString(payload);

    dispatch(
      showBottomNotificationModal({
        type: 'info',
        title: 'USDT Debug Copied',
        message:
          'USDT navigation diagnostics were copied to clipboard. Paste them here.',
        enableBackdropDismiss: true,
        actions: [
          {
            text: 'OK',
            action: () => null,
            primary: true,
          },
        ],
      }),
    );
  }, [dispatch, getUsdtNavigationDebugPayload, isUsdtRow]);

  const handlePress = () => {
    if (suppressNextPressRef.current) {
      suppressNextPressRef.current = false;
      return;
    }

    if (!canNavigate || !option) {
      return;
    }

    navigation.navigate('ExchangeRate', {
      currencyName: option.currencyName || item.name,
      currencyAbbreviation:
        option.currencyAbbreviation || item.currencyAbbreviation,
      chain: option.chain || item.chain,
      tokenAddress: option.tokenAddress || item.tokenAddress,
    });
  };

  return (
    <Row
      activeOpacity={canNavigate ? ActiveOpacity : 1}
      isLast={isLast}
      delayLongPress={isUsdtRow ? 3000 : undefined}
      onLongPress={isUsdtRow ? handleUsdtLongPress : undefined}
      onPress={canNavigate ? handlePress : undefined}>
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
        ) : isCryptoAmountLoading ? (
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

      {shouldShowRightSide ? (
        <>
          <Values>
            {hideAllBalances ? (
              <>
                <FiatAmount>
                  {hasRate ? maskIfHidden(true, fiatAmountDisplay) : '—'}
                </FiatAmount>
                {shouldShowDeltaFiat ? (
                  <DeltaFiat isPositive={item.isPositive} hasPnl={hasPnl}>
                    {maskIfHidden(true, item.deltaFiat)}
                  </DeltaFiat>
                ) : null}
              </>
            ) : (isFiatLoading || isPopulateLoading) && !showPnlPlaceholder ? (
              <SkeletonPlaceholder
                backgroundColor={theme.dark ? CharcoalBlack : NeutralSlate}
                highlightColor={theme.dark ? LightBlack : GhostWhite}>
                <SkeletonPlaceholder.Item
                  width={72}
                  height={12}
                  borderRadius={2}
                  marginBottom={shouldShowDeltaFiat ? 6 : 0}
                />
                {shouldShowDeltaFiat ? (
                  <SkeletonPlaceholder.Item
                    width={54}
                    height={12}
                    borderRadius={2}
                  />
                ) : null}
              </SkeletonPlaceholder>
            ) : (
              <>
                <FiatAmount>{fiatAmountDisplay}</FiatAmount>
                {shouldShowDeltaFiat ? (
                  <DeltaFiat isPositive={item.isPositive} hasPnl={hasPnl}>
                    {item.deltaFiat}
                  </DeltaFiat>
                ) : null}
              </>
            )}
          </Values>

          <PercentPill>
            {(isFiatLoading || isPopulateLoading) && !showPnlPlaceholder ? (
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
              <PercentText isPositive={item.isPositive} hasPnl={hasPnl}>
                {item.deltaPercent}
              </PercentText>
            )}
          </PercentPill>
        </>
      ) : null}

      <ChevronContainer visible={canNavigate}>
        <ChevronRightSvg width={9} height={15} gray />
      </ChevronContainer>
    </Row>
  );
};

export default React.memo(AssetRow);
