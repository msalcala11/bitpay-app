import React, {useLayoutEffect, useMemo} from 'react';
import styled, {useTheme} from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {RootStackParamList} from '../../../../Root';
import {useStackScreenOptions} from '../../../utils/headerHelpers';
import {HeaderTitle, BaseText} from '../../../../components/styled/Text';
import HeaderBackButton from '../../../../components/back/HeaderBackButton';
import Settings from '../../../../components/settings/Settings';
import {SupportedCurrencyOptions} from '../../../../constants/SupportedCurrencyOptions';
import {CurrencyImage} from '../../../../components/currency-image/CurrencyImage';
import {AllocationDonutLegendCard} from '../components/AllocationSection';
import {
  LightBlack,
  Slate,
  Slate30,
  SlateDark,
} from '../../../../styles/colors';

type Props = NativeStackScreenProps<RootStackParamList, 'Allocation'>;

type AllocationRowItem = {
  key: string;
  currencyAbbreviation: string;
  chain: string;
  name: string;
  fiatAmount: string;
  percent: string;
  barColor: {
    light: string;
    dark: string;
  };
  progress: number;
};

const ScreenContainer = styled.SafeAreaView`
  flex: 1;
`;

const Content = styled.ScrollView`
  flex: 1;
`;

const Rows = styled.View`
  margin: 0px 16px 24px;
`;

const Row = styled.View`
  padding: 14px 0;
`;

const RowTop = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
`;

const RowLeft = styled.View`
  flex-direction: row;
  align-items: center;
  flex: 1;
`;

const IconContainer = styled.View`
  width: 48px;
  height: 48px;
  align-items: center;
  justify-content: center;
  margin-right: 12px;
`;

const RowLabels = styled.View`
  flex: 1;
  justify-content: center;
`;

const AssetName = styled(BaseText)`
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme}) => theme.colors.text};
`;

const AssetSymbol = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const RowRight = styled.View`
  align-items: flex-end;
  justify-content: center;
  margin-left: 12px;
`;

const FiatAmount = styled(BaseText)`
  font-size: 14px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme}) => theme.colors.text};
`;

const Percent = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const ProgressTrack = styled.View`
  margin-top: 10px;
  height: 10px;
  border-radius: 50px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Slate30)};
  overflow: hidden;
`;

const ProgressFill = styled.View<{
  progress: number;
  color: string;
}>`
  height: 10px;
  width: ${({progress}) => `${Math.min(100, Math.max(0, progress))}%`};
  border-radius: 50px;
  background-color: ${({color}) => color};
`;

const Allocation: React.FC<Props> = ({navigation}) => {
  const theme = useTheme();
  const commonOptions = useStackScreenOptions(theme);

  useLayoutEffect(() => {
    navigation.setOptions({
      ...commonOptions,
      headerLeft: () => <HeaderBackButton />,
      headerTitle: () => <HeaderTitle>Allocation</HeaderTitle>,
      headerRight: () => <Settings onPress={() => {}} />,
    });
  }, [navigation, commonOptions]);

  const legendItems = useMemo(
    () => [
      {
        key: 'btc',
        label: 'BTC',
        value: '53.4%',
        color: {light: '#F7931A', dark: '#F7931A'},
      },
      {
        key: 'eth',
        label: 'ETH',
        value: '32.1%',
        color: {light: '#627EEA', dark: '#627EEA'},
      },
      {
        key: 'usdc',
        label: 'USDC',
        value: '8.3%',
        color: {light: '#2775CA', dark: '#2775CA'},
      },
      {
        key: 'xrp',
        label: 'XRP',
        value: '9.8%',
        color: {light: '#000000', dark: '#000000'},
      },
      {
        key: 'sol',
        label: 'SOL',
        value: '19.8%',
        color: {light: '#7C3AED', dark: '#7C3AED'},
      },
      {
        key: 'other',
        label: 'Other',
        color: {light: Slate, dark: SlateDark},
      },
    ],
    [],
  );

  const slices = useMemo(
    () => [
      {key: 'btc', value: 53.4, color: {light: '#F7931A', dark: '#F7931A'}},
      {key: 'eth', value: 32.1, color: {light: '#627EEA', dark: '#627EEA'}},
      {key: 'sol', value: 19.8, color: {light: '#7C3AED', dark: '#7C3AED'}},
      {key: 'usdc', value: 8.3, color: {light: '#2775CA', dark: '#2775CA'}},
      {key: 'xrp', value: 9.8, color: {light: '#000000', dark: '#000000'}},
      {key: 'other', value: 6.6, color: {light: SlateDark, dark: SlateDark}},
    ],
    [],
  );

  const rows: AllocationRowItem[] = useMemo(
    () => [
      {
        key: 'btc',
        currencyAbbreviation: 'btc',
        chain: 'btc',
        name: 'Bitcoin',
        fiatAmount: '$58,525.18',
        percent: '59.6%',
        progress: 59.6,
        barColor: {light: '#F7931A', dark: '#F7931A'},
      },
      {
        key: 'eth',
        currencyAbbreviation: 'eth',
        chain: 'eth',
        name: 'Ethereum',
        fiatAmount: '$58,525.18',
        percent: '25.4%',
        progress: 25.4,
        barColor: {light: '#627EEA', dark: '#627EEA'},
      },
      {
        key: 'xrp',
        currencyAbbreviation: 'xrp',
        chain: 'xrp',
        name: 'XRP',
        fiatAmount: '$7,815.88',
        percent: '7.9%',
        progress: 7.9,
        barColor: {light: '#000000', dark: '#000000'},
      },
      {
        key: 'sol',
        currencyAbbreviation: 'sol',
        chain: 'sol',
        name: 'Solana',
        fiatAmount: '$4,242.04',
        percent: '4.3%',
        progress: 4.3,
        barColor: {light: '#7C3AED', dark: '#7C3AED'},
      },
      {
        key: 'pol',
        currencyAbbreviation: 'pol',
        chain: 'pol',
        name: 'Polygon',
        fiatAmount: '$2,645.10',
        percent: '2.8%',
        progress: 2.8,
        barColor: {light: '#7C3AED', dark: '#7C3AED'},
      },
      {
        key: 'usdc',
        currencyAbbreviation: 'usdc',
        chain: 'eth',
        name: 'USDC',
        fiatAmount: '$1,989.11',
        percent: '2.1%',
        progress: 2.1,
        barColor: {light: '#2775CA', dark: '#2775CA'},
      },
    ],
    [],
  );

  return (
    <ScreenContainer>
      <Content>
        <AllocationDonutLegendCard legendItems={legendItems} slices={slices} />

        <Rows>
          {rows.map(item => {
            const option = SupportedCurrencyOptions.find(o => {
              return (
                o.currencyAbbreviation === item.currencyAbbreviation &&
                o.chain === item.chain
              );
            });

            const barColor = theme.dark ? item.barColor.dark : item.barColor.light;

            return (
              <Row key={item.key}>
                <RowTop>
                  <RowLeft>
                    <IconContainer>
                      <CurrencyImage
                        img={option?.img}
                        imgSrc={option?.imgSrc as unknown as number}
                        size={48}
                      />
                    </IconContainer>
                    <RowLabels>
                      <AssetName>{item.name}</AssetName>
                      <AssetSymbol>{item.currencyAbbreviation.toUpperCase()}</AssetSymbol>
                    </RowLabels>
                  </RowLeft>

                  <RowRight>
                    <FiatAmount>{item.fiatAmount}</FiatAmount>
                    <Percent>{item.percent}</Percent>
                  </RowRight>
                </RowTop>

                <ProgressTrack>
                  <ProgressFill progress={item.progress} color={barColor} />
                </ProgressTrack>
              </Row>
            );
          })}
        </Rows>
      </Content>
    </ScreenContainer>
  );
};

export default Allocation;
