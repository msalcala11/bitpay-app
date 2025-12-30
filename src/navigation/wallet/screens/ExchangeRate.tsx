import {RouteProp, useNavigation, useRoute} from '@react-navigation/native';
import React, {useLayoutEffect, useMemo, useState} from 'react';
import {ScrollView, View} from 'react-native';
import {LineGraph} from 'react-native-graph';
import {Path, Svg} from 'react-native-svg';
import styled, {useTheme} from 'styled-components/native';
import HeaderBackButton from '../../../components/back/HeaderBackButton';
import {CurrencyImage} from '../../../components/currency-image/CurrencyImage';
import Percentage from '../../../components/percentage/Percentage';
import {
  ActiveOpacity,
  CardContainer,
  ScreenGutter,
  WIDTH,
} from '../../../components/styled/Containers';
import {BaseText, H2, H5, HeaderTitle, Link} from '../../../components/styled/Text';
import {BitpaySupportedCoins} from '../../../constants/currencies';
import LinkingButtons from '../../tabs/home/components/LinkingButtons';
import {LightBlack, LuckySevens, ProgressBlue, Slate, Slate10, Slate30, SlateDark, White} from '../../../styles/colors';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import type {WalletGroupParamList} from '../WalletGroup';
import {Network} from '../../../constants';
import {buildUIFormattedWallet} from '../../../store/wallet/utils/wallet';
import type {Wallet} from '../../../store/wallet/wallet.models';
import type {Key} from '../../../store/wallet/wallet.models';
import type {RootState} from '../../../store';
import {formatCryptoAddress} from '../../../utils/helper-methods';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {sendCrypto, receiveCrypto} from '../../../store/wallet/effects/send/send';
import {ExternalServicesScreens} from '../../services/ExternalServicesGroup';

const ScreenContainer = styled.SafeAreaView`
  flex: 1;
`;

const HeaderRight = styled.View`
  flex-direction: row;
  gap: 10px;
`;

const CircleButton = styled(TouchableOpacity)`
  width: 40px;
  height: 40px;
  border-radius: 20px;
  align-items: center;
  justify-content: center;
  background-color: ${({theme}) => (theme.dark ? '#252525' : '#F5F7F8')};
`;

const HeaderTitleText = styled(HeaderTitle)`
  font-size: 20px;
`;

const TopSection = styled.View`
  margin-top: 10px;
  align-items: center;
  padding: 0 16px;
`;

const AbbreviationLabel = styled(BaseText)`
  font-size: 13px;
  line-height: 18px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
  text-transform: uppercase;
  font-weight: 400;
  margin-bottom: 2px;
`;

const PriceText = styled(H2)`
  line-height: 50px;
  margin-bottom: 5px;
`;

const PercentRow = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: center;
`;

const ChartContainer = styled.View`
  margin-top: 16px;
`;

const TimeframeContainer = styled.View`
  margin-top: 18px;
  padding: 0 12px;
`;

const TimeframeRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-self: center;
  width: ${WIDTH - 24}px;
  max-width: 360px;
`;

const TimeframePill = styled(TouchableOpacity)<{active: boolean}>`
  height: 34px;
  min-width: 44px;
  padding: 0 12px;
  border-radius: 18px;
  align-items: center;
  justify-content: center;
  background-color: ${({theme, active}) =>
    active ? (theme.dark ? '#0C204E' : '#EDF0FE') : 'transparent'};
`;

const TimeframeText = styled(BaseText)<{active: boolean}>`
  font-size: 14px;
  font-weight: ${({active}) => (active ? 500 : 400)};
  color: ${({theme, active}) =>
    active ? (theme.dark ? White : ProgressBlue) : theme.dark ? '#9BA3AE' : '#434D5A'};
`;

const ActionsContainer = styled.View`
  margin-top: 20px;
  margin-bottom: 15px;
`;

const SectionTitle = styled(H5)`
  font-size: 20px;
  font-style: normal;
  font-weight: 700;
  line-height: 30px;
  margin: 18px ${ScreenGutter} 3px;
`;

const WalletCard = styled(TouchableOpacity)`
  border: 1px solid ${({theme}) => (theme.dark ? LightBlack : Slate10)};
  background-color: ${({theme: {dark}}) => (dark ? '#111' : Slate10)};
  border-radius: 12px;
  margin: 8px ${ScreenGutter};
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 15px;
  height: 75px;
`;

const WalletLeft = styled.View`
  flex: 1;
  padding-right: 10px;
`;

const WalletName = styled(BaseText)`
  font-size: 16px;
  font-style: normal;
  font-weight: 400;
  line-height: 24px;
  color: ${({theme}) => theme.colors.text};
`;

const WalletSub = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 400;
  line-height: 20px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : LuckySevens)};
`;

const WalletRight = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 10px;
`;

const WalletAmount = styled(BaseText)`
  font-size: 16px;
  font-style: normal;
  font-weight: 400;
  line-height: 24px;
  color: ${({theme}) => theme.colors.text};
`;

const MarketCardContainer = styled.View`
  margin: 20px ${ScreenGutter} 20px;
  border: 1px solid ${({theme}) => (theme.dark ? LightBlack : Slate30)};
  border-radius: 12px;
`;

const MarketHeader = styled.View`
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
`;

const MarketHeaderLeft = styled.View`
  flex-direction: row;
  align-items: center;
  gap: 10px;
`;

const MarketTitle = styled(BaseText)`
  font-size: 16px;
  font-style: normal;
  font-weight: 500;
  line-height: 24px;
  color: ${({theme}) => theme.colors.text};
`;

const MarketPrice = styled(BaseText)`
  font-size: 16px;
  font-style: normal;
  font-weight: 700;
  line-height: 24px;
  color: ${({theme}) => theme.colors.text};
`;

const Divider = styled.View`
  height: 1px;
  background-color: ${({theme}) => (theme.dark ? LightBlack : Slate30)};
`;

const MarketBody = styled.View`
  padding: 14px;
  background-color: ${({theme: {dark}}) => (dark ? '#111' : Slate10)};
`;

const SubSectionTitle = styled(BaseText)`
  font-size: 13px;
  font-style: normal;
  font-weight: 600;
  line-height: 20px;
  color: ${({theme}) => theme.colors.text};
  margin-bottom: 10px;
`;

const StatsGridRow = styled.View`
  flex-direction: row;
`;

const StatBlock = styled.View`
  flex: 1;
  flex-basis: 0px;
`;

const StatLabel = styled(BaseText)`
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 15px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
  margin-bottom: 4px;
`;

const StatValue = styled(BaseText)`
  font-size: 16px;
  font-style: normal;
  font-weight: 400;
  line-height: 24px;
  color: ${({theme}) => theme.colors.text};
`;

const AboutText = styled(BaseText)`
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 15px;
  color: ${({theme: {dark}}) => (dark ? Slate30 : SlateDark)};
`;

const RightIconSvg = ({type}: {type: 'star' | 'bell'}) => {
  const theme = useTheme();
  const fill = theme.dark ? Slate30 : SlateDark;

  if (type === 'star') {
    return (
      <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27Z"
          fill={fill}
        />
      </Svg>
    );
  }

  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2Zm6-6V11c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5S10.5 3.17 10.5 4v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2Z"
        fill={fill}
      />
    </Svg>
  );
};

const ExchangeRate = () => {
  const theme = useTheme();
  const navigation = useNavigation();
  const dispatch = useAppDispatch();
  const keys = useAppSelector(({WALLET}: RootState) => WALLET.keys);
  const rates = useAppSelector(({RATE}: RootState) => RATE.rates);
  const defaultAltCurrency = useAppSelector(
    ({APP}: RootState) => APP.defaultAltCurrency,
  );
  const hideAllBalances = useAppSelector(({APP}: RootState) => APP.hideAllBalances);
  const {params} = useRoute<RouteProp<WalletGroupParamList, 'ExchangeRate'>>();
  const [selectedTimeframe, setSelectedTimeframe] = useState('All');

  const currencyName = params?.currencyName || 'Bitcoin';
  const currencyAbbreviation = (params?.currencyAbbreviation || 'BTC').toUpperCase();
  const coinKey = (params?.chain || params?.currencyAbbreviation || 'btc').toLowerCase();
  const coin = BitpaySupportedCoins[coinKey] ?? BitpaySupportedCoins.btc;

  const assetContext = useMemo(
    () => ({
      currencyAbbreviation: (params?.currencyAbbreviation || 'btc').toLowerCase(),
      chain: (params?.chain || params?.currencyAbbreviation || 'btc').toLowerCase(),
      network: params?.network?.toLowerCase(),
      tokenAddress: params?.tokenAddress?.toLowerCase(),
    }),
    [params?.chain, params?.currencyAbbreviation, params?.network, params?.tokenAddress],
  );

  const points = useMemo(() => {
    const now = Date.now();
    const data = [
      86000, 84500, 87000, 85500, 90000, 92000, 91000, 94000, 93000, 96500,
      99000, 97500, 101000, 103500, 106000, 109500, 112000, 111000, 114500,
      117500, 116000, 119458.18,
    ];

    return data.map((value, idx) => {
      const daysAgo = data.length - 1 - idx;
      return {
        date: new Date(now - daysAgo * 24 * 60 * 60 * 1000),
        value,
      };
    });
  }, []);

  const {coinColor, gradientBackgroundColor} =
    coin.theme ?? {
      coinColor: ProgressBlue,
      gradientBackgroundColor: theme.dark ? 'transparent' : White,
    };

  const walletsForAsset = useMemo(() => {
    const allWallets: Wallet[] = (Object.values(keys) as Key[]).flatMap(
      k => k.wallets,
    );
    const filtered = allWallets
      .filter(w => w.network !== Network.testnet)
      .filter(w => !w.hideWallet && !w.hideWalletByAccount)
      .filter(w => (w.balance?.sat ?? 0) > 0)
      .filter(w => {
        const matchesCurrency =
          (w.currencyAbbreviation || '').toLowerCase() ===
          assetContext.currencyAbbreviation;
        const matchesChain = (w.chain || '').toLowerCase() === assetContext.chain;
        const matchesNetwork = assetContext.network
          ? (w.network || '').toLowerCase() === assetContext.network
          : true;
        const matchesTokenAddress = assetContext.tokenAddress
          ? (w.tokenAddress || '').toLowerCase() === assetContext.tokenAddress
          : true;
        return matchesCurrency && matchesChain && matchesNetwork && matchesTokenAddress;
      })
      .map(wallet => {
        const ui = buildUIFormattedWallet(
          wallet,
          defaultAltCurrency.isoCode,
          rates,
          dispatch,
          'symbol',
        );
        return {wallet, ui};
      })
      .sort((a, b) => (b.ui.fiatBalance || 0) - (a.ui.fiatBalance || 0));

    return filtered;
  }, [assetContext.chain, assetContext.currencyAbbreviation, assetContext.network, assetContext.tokenAddress, defaultAltCurrency.isoCode, dispatch, keys, rates]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <HeaderTitleText>{currencyName}</HeaderTitleText>,
      headerLeft: () => <HeaderBackButton />, 
      headerRight: () => (
        <HeaderRight>
          <CircleButton activeOpacity={ActiveOpacity} onPress={() => {}}>
            <RightIconSvg type="star" />
          </CircleButton>
          <CircleButton activeOpacity={ActiveOpacity} onPress={() => {}}>
            <RightIconSvg type="bell" />
          </CircleButton>
        </HeaderRight>
      ),
    });
  }, [currencyName, navigation]);

  const timeframes = ['All', '1D', '1W', '1M', '3M', '1Y', '5Y'];

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={{paddingBottom: 30}}>
        <TopSection>
          <AbbreviationLabel>{currencyAbbreviation}</AbbreviationLabel>
          <PriceText>$119,458.18</PriceText>
          <PercentRow>
            <Percentage
              percentageDifference={607}
              hideArrow
              hideSign
              priceChange="$50,894.03"
              rangeLabel="All-time"
            />
          </PercentRow>
        </TopSection>

        <ChartContainer>
          <LineGraph
            points={points}
            animated={true}
            gradientFillColors={[
              gradientBackgroundColor,
              theme.dark ? 'transparent' : White,
            ]}
            color={theme.dark && coinColor === '#000000' ? White : coinColor}
            style={{width: WIDTH, height: 200, marginTop: 10}}
          />
        </ChartContainer>

        <TimeframeContainer>
          <TimeframeRow>
            {timeframes.map(label => {
              const active = selectedTimeframe === label;
              return (
                <TimeframePill
                  key={label}
                  active={active}
                  activeOpacity={ActiveOpacity}
                  onPress={() => setSelectedTimeframe(label)}>
                  <TimeframeText active={active}>{label}</TimeframeText>
                </TimeframePill>
              );
            })}
          </TimeframeRow>
        </TimeframeContainer>

        <ActionsContainer>
          <LinkingButtons
            buy={{
              cta: () => {
                navigation.navigate(ExternalServicesScreens.ROOT_BUY_AND_SELL, {
                  context: 'buyCrypto',
                  currencyAbbreviation: assetContext.currencyAbbreviation,
                  chain: assetContext.chain,
                });
              },
            }}
            sell={{
              cta: () => {
                navigation.navigate(ExternalServicesScreens.ROOT_BUY_AND_SELL, {
                  context: 'sellCrypto',
                  currencyAbbreviation: assetContext.currencyAbbreviation,
                  chain: assetContext.chain,
                });
              },
            }}
            swap={{
              cta: () => {
                navigation.navigate('GlobalSelect', {
                  context: 'swapFrom',
                  assetContext,
                });
              },
            }}
            receive={{
              cta: () => {
                dispatch(receiveCrypto(navigation as any, 'ExchangeRate', assetContext));
              },
            }}
            send={{
              cta: () => {
                dispatch(sendCrypto('ExchangeRate', assetContext));
              },
            }}
          />
        </ActionsContainer>

        {walletsForAsset.length ? (
          <>
            <SectionTitle>{`Your Wallets with ${currencyAbbreviation}`}</SectionTitle>

            {walletsForAsset.map(({wallet, ui}) => (
              <WalletCard
                key={ui.id}
                activeOpacity={ActiveOpacity}
                onPress={() => {
                  navigation.navigate('WalletDetails', {
                    walletId: wallet.credentials?.walletId || wallet.id,
                    key: keys[wallet.keyId],
                    copayerId: wallet.credentials?.copayerId,
                  });
                }}>
                <WalletLeft>
                  <WalletName numberOfLines={1} ellipsizeMode="tail">
                    {ui.walletName}
                  </WalletName>
                  <WalletSub numberOfLines={1} ellipsizeMode="tail">
                    {ui.receiveAddress
                      ? formatCryptoAddress(ui.receiveAddress)
                      : ''}
                  </WalletSub>
                </WalletLeft>
                <WalletRight>
                  <WalletAmount>
                    {hideAllBalances
                      ? '****'
                      : ui.network === Network.testnet
                        ? 'Test - No Value'
                        : ui.fiatBalanceFormat || '$0.00'}
                  </WalletAmount>
                  <RightChevron />
                </WalletRight>
              </WalletCard>
            ))}
          </>
        ) : null}

        <MarketCardContainer>
          <CardContainer style={{backgroundColor: 'transparent'}}>
            <MarketHeader>
              <MarketHeaderLeft>
                <View style={{width: 26, height: 26}}>
                  <CurrencyImage img={coin.img} size={26} />
                </View>
                <MarketTitle>{`${currencyAbbreviation} Market Price`}</MarketTitle>
              </MarketHeaderLeft>
              <MarketPrice>$119,458.18</MarketPrice>
            </MarketHeader>
            <Divider />
            <MarketBody>
              <SubSectionTitle>Bitcoin Stats</SubSectionTitle>

              <StatsGridRow>
                <StatBlock style={{paddingRight: 8}}>
                  <StatLabel>52wk high</StatLabel>
                  <StatValue>$121,131.47</StatValue>
                </StatBlock>
                <View>
                  <StatBlock>
                    <StatLabel>52wk low</StatLabel>
                    <StatValue>$89,141.35</StatValue>
                  </StatBlock>
                </View>
                <StatBlock style={{alignItems: 'flex-end'}}>
                  <StatLabel>24h volume</StatLabel>
                  <StatValue>$23.98B</StatValue>
                </StatBlock>
              </StatsGridRow>

              <View style={{marginTop: 14}} />
              <Divider />
              <View style={{marginTop: 14}} />

              <StatsGridRow>
                <StatBlock style={{paddingRight: 8, flexGrow: 1.3}}>
                  <StatLabel>Circulating supply</StatLabel>
                  <StatValue>{`19,770,625 ${currencyAbbreviation}`}</StatValue>
                </StatBlock>
                <StatBlock>
                  <StatLabel>Market cap</StatLabel>
                  <StatValue>$1.98T</StatValue>
                </StatBlock>
                <StatBlock style={{opacity: 0, alignItems: 'flex-end'}}>
                  <StatLabel>Market cap</StatLabel>
                  <StatValue>$1.98T</StatValue>
                </StatBlock>
              </StatsGridRow>

              <View style={{marginTop: 16}} />
              <Divider />

              <View style={{marginTop: 14}}>
                <SubSectionTitle style={{fontWeight: '400', marginBottom: 6}}>About</SubSectionTitle>
                <AboutText numberOfLines={3} ellipsizeMode="tail">
                  A purely peer-to-peer version of electronic cash would allow online payments to be sent directly from one party to another without going through a financial institution...
                </AboutText>
                <View style={{marginTop: 15}}>
                  <Link style={{fontSize: 13}} onPress={() => {}}>Show more</Link>
                </View>
              </View>
            </MarketBody>
          </CardContainer>
        </MarketCardContainer>
      </ScrollView>
    </ScreenContainer>
  );
};

const RightChevron = () => {
  const theme = useTheme();
  const stroke = theme.dark ? Slate : SlateDark;
  return (
    <Svg width={7} height={13} viewBox="0 0 10 16" fill="none">
      <Path
        d="M1 1L8 8L1 15"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
};

export default ExchangeRate;
