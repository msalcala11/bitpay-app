import {useNavigation, useTheme} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useLayoutEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Platform, View} from 'react-native';
import styled from 'styled-components/native';
import {GraphPoint, LineGraph} from 'react-native-graph';
import Button from '../../../components/button/Button';
import {CtaContainer, Hr, ScreenGutter, WIDTH} from '../../../components/styled/Containers';
import {BaseText, H5, HeaderTitle} from '../../../components/styled/Text';
import {LightBlack, ProgressBlue, SlateDark, White} from '../../../styles/colors';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  makeSelectWalletAssetListByInterval,
  makeSelectWalletChartSeries,
} from '../../../store/portfolio';
import {WalletGroupParamList} from '../WalletGroup';
import {formatFiatAmount} from '../../../utils/helper-methods';
import {portfolioBackfillAllWalletTxs} from '../../../store/portfolio/portfolio.effects';

const AnyLineGraph = LineGraph as any;

export type WalletPortfolioDebugScreenParamList = {
  walletId: string;
};

type Props = NativeStackScreenProps<WalletGroupParamList, 'WalletPortfolioDebug'>;

type IntervalOption = {
  label: string;
  interval: '1D' | '1W' | '1M' | '3M' | '1Y' | '5Y' | 'ALL';
};

const Container = styled.SafeAreaView`
  flex: 1;
`;

const ScrollView = styled.ScrollView`
  flex: 1;
`;

const Section = styled.View`
  padding: ${ScreenGutter};
`;

const SectionTitle = styled(H5)`
  margin-bottom: 10px;
`;

const ChartWrapper = styled.View`
  width: ${WIDTH}px;
  height: 240px;
  align-self: center;
`;

const ChartLayer = styled.View`
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
`;

const Row = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
`;

const Label = styled(BaseText)`
  flex: 1;
  margin-right: 10px;
`;

const Value = styled(BaseText)`
  text-align: right;
`;

const IntervalRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  padding: 0 ${ScreenGutter};
  margin-top: 10px;
`;

const IntervalButton = styled.TouchableOpacity<{active: boolean}>`
  padding: 8px 10px;
  border-radius: 16px;
  background-color: ${({theme, active}) =>
    active ? (theme.dark ? LightBlack : '#EDF0FE') : 'transparent'};
`;

const IntervalButtonText = styled(BaseText)<{active: boolean}>`
  font-weight: ${({active}) => (active ? 600 : 400)};
  color: ${({theme, active}) =>
    active ? (theme.dark ? White : SlateDark) : theme.dark ? White : SlateDark};
`;

const LoadingContainer = styled.View`
  height: 240px;
  justify-content: center;
  align-items: center;
`;

const intervals: IntervalOption[] = [
  {label: '1D', interval: '1D'},
  {label: '1W', interval: '1W'},
  {label: '1M', interval: '1M'},
  {label: '3M', interval: '3M'},
  {label: '1Y', interval: '1Y'},
  {label: '5Y', interval: '5Y'},
  {label: 'ALL', interval: 'ALL'},
];

const WalletPortfolioDebug: React.FC<Props> = ({route}) => {
  const navigation = useNavigation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const {walletId} = route.params;
  const fiatCode = useAppSelector(({APP}) => APP.defaultAltCurrency.isoCode);

  const walletSync = useAppSelector(({PORTFOLIO}) => PORTFOLIO.wallets[walletId]);
  const globalSync = useAppSelector(({PORTFOLIO}) => PORTFOLIO.global);

  const [interval, setInterval] = useState<IntervalOption>(intervals[2]);

  const selectAssetList = useMemo(
    () => makeSelectWalletAssetListByInterval(walletId, fiatCode, interval.interval),
    [walletId, fiatCode, interval.interval],
  );

  const selectSeries = useMemo(
    () => makeSelectWalletChartSeries(walletId, fiatCode, interval.interval),
    [walletId, fiatCode, interval.interval],
  );

  const assetList = useAppSelector(selectAssetList);
  const series = useAppSelector(selectSeries);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <HeaderTitle>Portfolio Debug</HeaderTitle>,
    });
  }, [navigation]);

  const chartValuePoints: GraphPoint[] = useMemo(() => {
    return (series?.points || []).map(p => ({date: new Date(p.ts), value: p.value}));
  }, [series?.points]);

  const chartBreakevenPoints: GraphPoint[] = useMemo(() => {
    return (series?.points || []).map(p => ({date: new Date(p.ts), value: p.breakeven}));
  }, [series?.points]);

  const showChartLoading = !series || !series.points || series.points.length === 0;

  const onPressBackfill = async () => {
    await dispatch(
      portfolioBackfillAllWalletTxs({
        fiatCode,
        walletIds: [walletId],
      }) as any,
    );
  };

  return (
    <Container>
      <ScrollView>
        <Section>
          <SectionTitle>Chart</SectionTitle>

          {walletSync?.status !== 'done' ? (
            <View style={{marginBottom: 10}}>
              <BaseText>
                Portfolio data is not synced for this wallet yet.
              </BaseText>
              {walletSync?.status === 'syncing' ? (
                <View style={{marginTop: 10}}>
                  <Row>
                    <Label>Backfill scope</Label>
                    <Value>{String(walletId)}</Value>
                  </Row>
                  <Row>
                    <Label>Global wallets</Label>
                    <Value>
                      {String(globalSync.walletsDone)}/{String(globalSync.walletsTotal)}
                    </Value>
                  </Row>
                  <Row>
                    <Label>Global current wallet</Label>
                    <Value>{String(globalSync.currentWalletId ?? '')}</Value>
                  </Row>
                  <Row>
                    <Label>Tx history requests</Label>
                    <Value>{String(walletSync.txRequestCount ?? 0)}</Value>
                  </Row>
                  <Row>
                    <Label>Txs cached</Label>
                    <Value>{String(walletSync.txCount ?? 0)}</Value>
                  </Row>
                  <Row>
                    <Label>Rate requests</Label>
                    <Value>{String(walletSync.rateRequestCount ?? 0)}</Value>
                  </Row>
                  <Row>
                    <Label>Rate days</Label>
                    <Value>
                      {String(walletSync.rateDaysDone ?? 0)}/
                      {String(walletSync.rateDaysTotal ?? 0)}
                    </Value>
                  </Row>
                </View>
              ) : null}
            </View>
          ) : null}

          <ChartWrapper>
            {showChartLoading ? (
              <LoadingContainer>
                <ActivityIndicator color={ProgressBlue} />
              </LoadingContainer>
            ) : (
              <>
                <ChartLayer pointerEvents="none">
                  <AnyLineGraph
                    points={chartBreakevenPoints}
                    animated={true}
                    gradientFillColors={['transparent', 'transparent']}
                    enablePanGesture={false}
                    color={theme.dark ? '#C3C8CF' : '#6B7280'}
                    style={{width: WIDTH, height: 240}}
                  />
                </ChartLayer>
                <ChartLayer>
                  <AnyLineGraph
                    points={chartValuePoints}
                    animated={true}
                    gradientFillColors={[
                      theme.dark ? 'rgba(3, 169, 244, 0.25)' : 'rgba(3, 169, 244, 0.15)',
                      'transparent',
                    ]}
                    enablePanGesture={true}
                    panGestureDelay={100}
                    color={theme.dark ? '#55B6FF' : '#0B74DE'}
                    style={{width: WIDTH, height: 240}}
                  />
                </ChartLayer>
              </>
            )}
          </ChartWrapper>
        </Section>

        <IntervalRow>
          {intervals.map(opt => (
            <IntervalButton
              key={opt.label}
              active={opt.interval === interval.interval}
              onPress={() => setInterval(opt)}>
              <IntervalButtonText active={opt.interval === interval.interval}>
                {opt.label}
              </IntervalButtonText>
            </IntervalButton>
          ))}
        </IntervalRow>

        <Section>
          <Row>
            <Label>Total Value</Label>
            <Value>{formatFiatAmount(assetList.totalValueFiat, fiatCode)}</Value>
          </Row>
          <Row>
            <Label>Breakeven (Cost Basis)</Label>
            <Value>{formatFiatAmount(assetList.totalCostBasisFiat, fiatCode)}</Value>
          </Row>
          <Row>
            <Label>Unrealized PnL</Label>
            <Value>{formatFiatAmount(assetList.totalPnlFiat, fiatCode)}</Value>
          </Row>
          {typeof assetList.totalIntervalPnlFiat === 'number' ? (
            <Row>
              <Label>Interval PnL</Label>
              <Value>
                {formatFiatAmount(assetList.totalIntervalPnlFiat, fiatCode)}
              </Value>
            </Row>
          ) : null}
        </Section>

        <Hr />

        <Section>
          <SectionTitle>Assets</SectionTitle>

          {assetList.assets.map(a => (
            <View key={a.assetKey}>
              <Row>
                <Label numberOfLines={1}>{a.coin.toUpperCase()}</Label>
                <Value>{a.units.toString()}</Value>
              </Row>
              <Row>
                <Label>Value</Label>
                <Value>{formatFiatAmount(a.valueFiat, fiatCode)}</Value>
              </Row>
              <Row>
                <Label>Breakeven</Label>
                <Value>{formatFiatAmount(a.costBasisFiat, fiatCode)}</Value>
              </Row>
              <Row>
                <Label>Unrealized PnL</Label>
                <Value>{formatFiatAmount(a.pnlFiat, fiatCode)}</Value>
              </Row>
              {typeof a.intervalPnlFiat === 'number' ? (
                <Row>
                  <Label>Interval PnL</Label>
                  <Value>{formatFiatAmount(a.intervalPnlFiat, fiatCode)}</Value>
                </Row>
              ) : null}
              <Hr />
            </View>
          ))}
        </Section>
      </ScrollView>

      {walletSync?.status !== 'done' ? (
        <CtaContainer
          style={{
            flexGrow: 0,
            flexShrink: 0,
            flexBasis: 'auto',
            marginBottom: Platform.OS === 'ios' ? 40 : 5,
          }}>
          <Button onPress={onPressBackfill} buttonStyle={'primary'}>
            Backfill Portfolio Data
          </Button>
        </CtaContainer>
      ) : null}
    </Container>
  );
};

export default WalletPortfolioDebug;
