import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {createMaterialTopTabNavigator} from '@react-navigation/material-top-tabs';
import moment from 'moment';
import React, {useLayoutEffect, useMemo} from 'react';
import {FlatList, View} from 'react-native';
import styled from 'styled-components/native';
import CustomTabBar from '../../../components/custom-tab-bar/CustomTabBar';
import {
  BaseText,
  H5,
  HeaderTitle,
} from '../../../components/styled/Text';
import {ScreenGutter} from '../../../components/styled/Containers';
import {formatFiatAmount} from '../../../utils/helper-methods';
import {useAppSelector} from '../../../utils/hooks';
import {makeSelectWalletEvents, readRateMap} from '../../../store/portfolio';
import {WalletGroupParamList, WalletScreens} from '../WalletGroup';

export type WalletPortfolioHistoryScreenParamList = {
  walletId: string;
};

type Props = NativeStackScreenProps<
  WalletGroupParamList,
  WalletScreens.WALLET_PORTFOLIO_HISTORY
>;

type WalletPortfolioEvent = {
  txid: string;
  time: number;
  assetKey: string;
  chain: string;
  coin: string;
  tokenAddress?: string;
  rateSymbol: string;
  deltaUnits: number;
  isInternalTransferCandidate: boolean;
};

type CryptoHistoryRow = {
  key: string;
  time: number;
  txid: string;
  deltaUnits: number;
  balanceUnits: number;
};

type FiatHistoryRow = {
  key: string;
  dayTs: number;
  balanceUnits: number;
  rate: number | null;
  valueFiat: number | null;
  fiatDeltaTx: number | null;
  fiatDeltaRate: number | null;
  fiatDeltaTotal: number | null;
};

const Container = styled.SafeAreaView`
  flex: 1;
`;

const TabContainer = styled.View`
  flex: 1;
  margin-top: 10px;
`;

const ListContainer = styled.View`
  flex: 1;
  padding: 0 ${ScreenGutter};
  margin-top: 10px;
`;

const Row = styled.View`
  padding: 12px 0;
`;

const RowHeader = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
`;

const RowBody = styled.View`
  margin-top: 6px;
  flex-direction: row;
  justify-content: space-between;
`;

const Mono = styled(BaseText)`
  font-family: ${props => (props.theme.dark ? 'Courier' : 'Courier')};
`;

const Muted = styled(BaseText)`
  opacity: 0.7;
`;

const Divider = styled.View`
  height: 1px;
  background-color: ${({theme}) => (theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')};
`;

const Title = styled(H5)`
  margin: 10px 0;
`;

const formatUnits = (v: number) =>
  v.toLocaleString(undefined, {
    maximumFractionDigits: 8,
  });

const WalletPortfolioHistoryCryptoTab: React.FC<{walletId: string}> = ({
  walletId,
}) => {
  const eventsSelector = useMemo(() => makeSelectWalletEvents(walletId), [walletId]);
  const events = useAppSelector(eventsSelector) as unknown as WalletPortfolioEvent[];

  const rows: CryptoHistoryRow[] = useMemo(() => {
    if (!events?.length) {
      return [];
    }

    // Because each wallet corresponds to a single asset, use the most common assetKey.
    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[e.assetKey] = (counts[e.assetKey] || 0) + 1;
    }
    const primaryAssetKey = Object.keys(counts).sort(
      (a, b) => (counts[b] || 0) - (counts[a] || 0),
    )[0];

    const sorted = [...events]
      .filter(e => e.assetKey === primaryAssetKey)
      .sort((a, b) => a.time - b.time);

    let running = 0;
    const out: CryptoHistoryRow[] = [];
    for (const e of sorted) {
      running += e.deltaUnits;
      out.push({
        key: `${e.txid}:${e.time}:${out.length}`,
        time: e.time,
        txid: e.txid,
        deltaUnits: e.deltaUnits,
        balanceUnits: running,
      });
    }

    // Newest first
    return out.reverse();
  }, [events]);

  return (
    <ListContainer>
      <Title>Crypto Balance History</Title>
      <FlatList
        data={rows}
        keyExtractor={item => item.key}
        ItemSeparatorComponent={() => <Divider />}
        renderItem={({item}) => (
          <Row>
            <RowHeader>
              <Muted>{moment(item.time).format('YYYY-MM-DD HH:mm')}</Muted>
              <Muted numberOfLines={1}>{item.txid}</Muted>
            </RowHeader>
            <RowBody>
              <View style={{flex: 1}}>
                <BaseText>Delta</BaseText>
                <Mono>{formatUnits(item.deltaUnits)}</Mono>
              </View>
              <View style={{flex: 1, alignItems: 'flex-end'}}>
                <BaseText>Balance</BaseText>
                <Mono>{formatUnits(item.balanceUnits)}</Mono>
              </View>
            </RowBody>
          </Row>
        )}
      />
    </ListContainer>
  );
};

const WalletPortfolioHistoryFiatTab: React.FC<{walletId: string}> = ({
  walletId,
}) => {
  const fiatCode = useAppSelector(({APP}) => APP.defaultAltCurrency.isoCode);
  const eventsSelector = useMemo(() => makeSelectWalletEvents(walletId), [walletId]);
  const events = useAppSelector(eventsSelector) as unknown as WalletPortfolioEvent[];

  const rows: FiatHistoryRow[] = useMemo(() => {
    if (!events?.length) {
      return [];
    }

    const counts: Record<string, number> = {};
    for (const e of events) {
      counts[e.assetKey] = (counts[e.assetKey] || 0) + 1;
    }
    const primaryAssetKey = Object.keys(counts).sort(
      (a, b) => (counts[b] || 0) - (counts[a] || 0),
    )[0];

    const filtered = events
      .filter(e => e.assetKey === primaryAssetKey)
      .sort((a, b) => a.time - b.time);

    const rateSymbol = filtered[0]?.rateSymbol;
    const rateMap = rateSymbol ? readRateMap(fiatCode, rateSymbol) : {};

    const deltaByDay: Record<string, number> = {};
    for (const e of filtered) {
      const dayKey = String(moment(e.time).startOf('day').valueOf());
      deltaByDay[dayKey] = (deltaByDay[dayKey] || 0) + e.deltaUnits;
    }

    const firstTs = filtered[0].time;
    const startDay = moment(firstTs).startOf('day');
    const endDay = moment().startOf('day');

    let balanceBefore = 0;
    let prevRate: number | null = null;
    let prevValue: number | null = null;

    const out: FiatHistoryRow[] = [];

    let cur = startDay.clone();
    while (cur.valueOf() <= endDay.valueOf()) {
      const dayTs = cur.valueOf();
      const dayKey = String(dayTs);

      const deltaUnits = deltaByDay[dayKey] || 0;
      const balanceAfter = balanceBefore + deltaUnits;

      const rate = typeof rateMap[dayKey] === 'number' ? rateMap[dayKey] : null;
      const valueFiat = rate != null ? balanceAfter * rate : null;

      const fiatDeltaTx = rate != null ? deltaUnits * rate : null;
      const fiatDeltaRate =
        rate != null && prevRate != null ? balanceBefore * (rate - prevRate) : null;

      const fiatDeltaTotal =
        valueFiat != null && prevValue != null ? valueFiat - prevValue : null;

      out.push({
        key: dayKey,
        dayTs,
        balanceUnits: balanceAfter,
        rate,
        valueFiat,
        fiatDeltaTx,
        fiatDeltaRate,
        fiatDeltaTotal,
      });

      balanceBefore = balanceAfter;
      if (rate != null) {
        prevRate = rate;
      }
      if (valueFiat != null) {
        prevValue = valueFiat;
      }
      cur = cur.clone().add(1, 'day');
    }

    return out.reverse();
  }, [events, fiatCode]);

  return (
    <ListContainer>
      <Title>Fiat Value History</Title>
      <FlatList
        data={rows}
        keyExtractor={item => item.key}
        ItemSeparatorComponent={() => <Divider />}
        renderItem={({item}) => (
          <Row>
            <RowHeader>
              <Muted>{moment(item.dayTs).format('YYYY-MM-DD')}</Muted>
              <Muted>
                {item.valueFiat == null
                  ? 'Missing rate'
                  : formatFiatAmount(item.valueFiat, fiatCode)}
              </Muted>
            </RowHeader>
            <RowBody>
              <View style={{flex: 1}}>
                <BaseText>Tx effect</BaseText>
                <Mono>
                  {item.fiatDeltaTx == null
                    ? '—'
                    : formatFiatAmount(item.fiatDeltaTx, fiatCode)}
                </Mono>
              </View>
              <View style={{flex: 1, alignItems: 'center'}}>
                <BaseText>Rate effect</BaseText>
                <Mono>
                  {item.fiatDeltaRate == null
                    ? '—'
                    : formatFiatAmount(item.fiatDeltaRate, fiatCode)}
                </Mono>
              </View>
              <View style={{flex: 1, alignItems: 'flex-end'}}>
                <BaseText>Total Δ</BaseText>
                <Mono>
                  {item.fiatDeltaTotal == null
                    ? '—'
                    : formatFiatAmount(item.fiatDeltaTotal, fiatCode)}
                </Mono>
              </View>
            </RowBody>
          </Row>
        )}
      />
    </ListContainer>
  );
};

const WalletPortfolioHistory: React.FC<Props> = ({navigation, route}) => {
  const {walletId} = route.params;
  const Tab = createMaterialTopTabNavigator();

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <HeaderTitle>Portfolio History</HeaderTitle>,
      headerTitleAlign: 'center',
    });
  }, [navigation]);

  return (
    <Container>
      <TabContainer>
        <Tab.Navigator tabBar={props => <CustomTabBar {...props} />}>
          <Tab.Screen
            name="Crypto"
            children={() => <WalletPortfolioHistoryCryptoTab walletId={walletId} />}
          />
          <Tab.Screen
            name="Fiat"
            children={() => <WalletPortfolioHistoryFiatTab walletId={walletId} />}
          />
        </Tab.Navigator>
      </TabContainer>
    </Container>
  );
};

export default WalletPortfolioHistory;
