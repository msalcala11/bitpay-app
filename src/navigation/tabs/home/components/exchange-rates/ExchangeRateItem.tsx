import React, {ReactElement, ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../../../../contexts';
import {CurrencyImage} from '../../../../../components/currency-image/CurrencyImage';
import {
  ActiveOpacity,
  Column,
  CurrencyColumn,
  CurrencyImageContainer,
} from '../../../../../components/styled/Containers';
import {H7, Smallest} from '../../../../../components/styled/Text';
import {
  formatCurrencyAbbreviation,
  formatFiatAmountObj,
} from '../../../../../utils/helper-methods';
import {Slate30, SlateDark} from '../../../../../styles/colors';
import {AccessibilityProps, StyleSheet, View} from 'react-native';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import Percentage from '../../../../../components/percentage/Percentage';
import {useIsLargeFont} from '../../../../../utils/hooks/useFontScale';

const styles = StyleSheet.create({
  rowContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 10,
  },
  noteContainer: {
    alignItems: 'flex-end',
    gap: 4,
  },
  subTextContainer: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  exchangeRateText: {
    fontSize: 16,
    lineHeight: 18,
    fontWeight: '400',
  },
  exchangeRateCode: {
    fontWeight: '500',
    fontSize: 10,
    paddingLeft: 2,
  },
  exchangeRateSubText: {
    lineHeight: 20,
    fontSize: 13,
  },
});

const RowContainer: React.FC<
  React.ComponentProps<typeof TouchableOpacity> & {stacked?: boolean}
> = ({style, stacked, ...rest}) => (
  <TouchableOpacity
    style={[
      styles.rowContainer,
      stacked && {flexDirection: 'column', alignItems: 'flex-start'},
      style,
    ]}
    {...rest}
  />
);

const NoteContainer: React.FC<
  React.ComponentProps<typeof Column> & {stacked?: boolean}
> = ({style, stacked, ...rest}) => (
  <Column
    style={[
      styles.noteContainer,
      stacked && {alignItems: 'flex-start', alignSelf: 'stretch', marginTop: 6},
      style,
    ]}
    {...rest}
  />
);

const SubTextContainer: React.FC<{children?: React.ReactNode}> = ({
  children,
}) => <View style={styles.subTextContainer}>{children}</View>;

const ExchangeRateText: React.FC<React.ComponentProps<typeof H7>> = ({
  style,
  ...rest
}) => <H7 style={[styles.exchangeRateText, style]} {...rest} />;

const ExchangeRateSubText: React.FC<{children?: React.ReactNode}> = ({
  children,
}) => {
  const theme = useTheme();
  return (
    <Smallest
      style={[
        styles.exchangeRateSubText,
        {color: theme.dark ? Slate30 : SlateDark},
      ]}>
      {children}
    </Smallest>
  );
};

export interface ExchangeRateItemProps {
  id: string;
  img: string | ((props?: any) => ReactElement);
  currencyName: string;
  chain: string;
  currencyAbbreviation: string;
  tokenAddress?: string;
  average?: number;
  currentPrice?: number;
}

const ExchangeRateItem = ({
  item,
  onPress,
  defaultAltCurrencyIsoCode,
  badge,
  ...accessibility
}: {
  item: ExchangeRateItemProps;
  onPress: () => void;
  defaultAltCurrencyIsoCode: string;
  badge?: ReactNode;
} & AccessibilityProps) => {
  const {t} = useTranslation();
  const stacked = useIsLargeFont();
  const {img, currencyName, currentPrice, average, currencyAbbreviation} = item;

  const {amount} = formatFiatAmountObj(
    currentPrice!,
    defaultAltCurrencyIsoCode,
    {
      customPrecision: 'minimal',
      currencyAbbreviation,
    },
  );

  return (
    <RowContainer
      stacked={stacked}
      activeOpacity={ActiveOpacity}
      testID={`home-exchange-rate-item-${item.id}`}
      accessibilityLabel={t('{{currency}} exchange rate', {
        currency: currencyName,
      })}
      accessibilityRole="button"
      {...accessibility}
      onPress={onPress}>
      <CurrencyImageContainer style={{width: 40, height: 40}}>
        <CurrencyImage img={img} size={40} />
      </CurrencyImageContainer>
      <CurrencyColumn>
        <ExchangeRateText ellipsizeMode="tail" numberOfLines={stacked ? 2 : 1}>
          {currencyName}
        </ExchangeRateText>
        {currencyAbbreviation ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 4,
            }}>
            <ExchangeRateSubText>
              {formatCurrencyAbbreviation(currencyAbbreviation)}
            </ExchangeRateSubText>
            {badge}
          </View>
        ) : null}
      </CurrencyColumn>
      <NoteContainer stacked={stacked}>
        {currentPrice ? (
          <>
            <ExchangeRateText>{amount}</ExchangeRateText>
            <SubTextContainer>
              {average === undefined ? (
                <ExchangeRateSubText>{'--'}</ExchangeRateSubText>
              ) : (
                <Percentage percentageDifference={average} hideArrow />
              )}
            </SubTextContainer>
          </>
        ) : (
          <ExchangeRateText>{'--'}</ExchangeRateText>
        )}
      </NoteContainer>
    </RowContainer>
  );
};

export default ExchangeRateItem;
