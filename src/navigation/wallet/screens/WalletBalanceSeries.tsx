import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ActivityIndicator, FlatList, RefreshControl, TouchableOpacity, View} from 'react-native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useNavigation} from '@react-navigation/native';
import styled, {useTheme} from 'styled-components/native';
import moment from 'moment';
import {useTranslation} from 'react-i18next';
import {LineGraph, GraphPoint} from 'react-native-graph';
import {LineChart} from 'react-native-gifted-charts';

import {WalletGroupParamList, WalletScreens} from '../WalletGroup';
import {useBalanceSeries, useBreakeven} from '../../../store/portfolio/hooks';
import {GetPrecision} from '../../../store/wallet/utils/currency';
import {findWalletById} from '../../../store/wallet/utils/wallet';
import {BalancePoint, CryptoCheckpoint, Timeframe, WalletContribution} from '../../../store/portfolio/portfolio.types';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {showBottomNotificationModal} from '../../../store/app/app.actions';
import {resetNetworkRequestCount, getNetworkRequestCount, getLastRequestUrl} from '../../../store/portfolio/rate-cache';
import {resetTxHistoryRequestCount, getTxHistoryRequestCount, getLastTxHistoryWallet} from '../../../store/portfolio/services/history';
import {selectPortfolioQuoteCurrency} from '../../../store/portfolio/selectors';
import {H5, Paragraph, Small} from '../../../components/styled/Text';
import {ScreenGutter, WIDTH} from '../../../components/styled/Containers';
import {Air, LightBlack, LuckySevens, ProgressBlue, White} from '../../../styles/colors';
import TabButton from '../../../components/tabs/TabButton';
import haptic from '../../../components/haptic-feedback/haptic';
import Clipboard from '@react-native-clipboard/clipboard';
import ChevronDownSvg from '../../../../assets/img/chevron-down.svg';
import ChevronUpSvg from '../../../../assets/img/chevron-up.svg';
import CopySvg from '../../../../assets/img/copy.svg';
import RefreshSvg from '../../../../assets/img/refresh.svg';

type ViewMode = 'fiat' | 'crypto';

const Container = styled.SafeAreaView`
  flex: 1;
`;

const SegmentContainer = styled.View`
  flex-direction: row;
  padding: 8px ${ScreenGutter};
  border-bottom-width: 1px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : Air)};
`;

const StatusContainer = styled.View`
  padding: ${ScreenGutter};
  border-bottom-width: 1px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : Air)};
`;

const StatusRow = styled.View`
  flex-direction: row;
  justify-content: space-between;
  align-items: baseline;
`;

const StatusLabel = styled(Small)`
  text-transform: uppercase;
`;

const StatusValue = styled(H5)`
  color: ${({theme: {dark}}) => (dark ? LuckySevens : '#0E9F6E')};
`;

const ErrorText = styled(Paragraph)`
  color: #d9534f;
  margin-top: 4px;
`;

const SeriesItem = styled.View`
  padding: ${ScreenGutter};
  border-bottom-width: 1px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? LightBlack : Air)};
`;

const QuoteValue = styled(H5)`
  margin-top: 4px;
`;

const BreakdownText = styled(Small)`
  margin-top: 4px;
  color: ${({theme: {dark}}) => (dark ? LuckySevens : '#6b7280')};
`;

const RateText = styled(Small)`
  margin-top: 4px;
  color: ${({theme: {dark}}) => (dark ? LuckySevens : '#6b7280')};
`;

const EmptyState = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
  padding: ${ScreenGutter};
`;

const ChartContainer = styled.View`
  height: 200px;
  margin: 16px 0;
`;

const LoadingContainer = styled.View`
  flex: 1;
  justify-content: center;
  align-items: center;
`;

const ScrollButtonContainer = styled.View`
  position: absolute;
  right: 20px;
  bottom: 30px;
  flex-direction: column;
  gap: 10px;
`;

const ScrollButton = styled(TouchableOpacity)`
  width: 44px;
  height: 44px;
  border-radius: 22px;
  background-color: ${ProgressBlue};
  justify-content: center;
  align-items: center;
  shadow-color: #000;
  shadow-offset: 0px 2px;
  shadow-opacity: 0.25;
  shadow-radius: 4px;
  elevation: 5;
`;

type WalletBalanceSeriesScreenProps = NativeStackScreenProps<
  WalletGroupParamList,
  'WalletBalanceSeries'
>;

const formatTimestamp = (timestamp: number) =>
  moment(timestamp).format('lll');

const formatQuoteValue = (value: number, currency: string) =>
  `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;

const WalletBalanceSeriesScreen: React.FC<WalletBalanceSeriesScreenProps> = ({
  route,
}) => {
  const {walletId, keyId, accountAddress, accountKeyId, timeframe = '1M', walletName, keyName, accountName} = route.params;
  const {t} = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation();
  const dispatch = useAppDispatch();
  const [viewMode, setViewMode] = useState<ViewMode>('fiat');
  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [networkRequests, setNetworkRequests] = useState<number | null>(null);
  const [lastRequestUrl, setLastRequestUrl] = useState<string>('');
  const [txHistoryRequests, setTxHistoryRequests] = useState<number | null>(null);
  const [lastTxHistoryWallet, setLastTxHistoryWallet] = useState<string>('');
  const fiatListRef = useRef<FlatList>(null);
  const cryptoListRef = useRef<FlatList>(null);

  // Determine entity type based on params
  // Priority: account > key > wallet > portfolio (fallback)
  const entity = useMemo(() => {
    if (accountAddress && accountKeyId) {
      return {type: 'account' as const, accountAddress, accountKeyId};
    }
    if (keyId) {
      return {type: 'key' as const, id: keyId};
    }
    if (walletId) {
      return {type: 'wallet' as const, id: walletId};
    }
    return {type: 'portfolio' as const};
  }, [accountAddress, accountKeyId, keyId, walletId]);
  const displayName = accountName || keyName || walletName || 'Portfolio';

  const quoteCurrency = useAppSelector(selectPortfolioQuoteCurrency);
  const keys = useAppSelector(state => state.WALLET.keys);
  
  // Get wallet precision for correct unit conversion (EVM uses 1e18, BTC uses 1e8)
  const unitToSatoshi = useMemo(() => {
    if (entity.type === 'wallet' && walletId) {
      const allWallets = Object.values(keys).flatMap((key: any) => key.wallets || []);
      const wallet = findWalletById(allWallets, walletId);
      if (wallet) {
        const precision = dispatch(GetPrecision(wallet.currencyAbbreviation, wallet.chain, wallet.tokenAddress));
        return precision?.unitToSatoshi || 1e8;
      }
    }
    return 1e8; // Default to BTC precision
  }, [entity.type, walletId, keys, dispatch]);

  const {data = [], cryptoTimeline = [], status, isLoading, reload} = useBalanceSeries({
    entity,
    timeframe: timeframe as Timeframe,
  });

  const breakeven = useBreakeven({entity, quoteCurrency});

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    setNetworkRequests(0);
    setTxHistoryRequests(0);
    resetNetworkRequestCount();
    resetTxHistoryRequestCount();
    reload();
  }, [reload]);

  // Poll network request count and URL while refreshing
  // Use a longer interval to avoid overwhelming React with state updates
  useEffect(() => {
    if (!isRefreshing) {
      return;
    }
    const interval = setInterval(() => {
      // Batch reads to minimize re-renders
      const txCount = getTxHistoryRequestCount();
      const txWallet = getLastTxHistoryWallet();
      const rateCount = getNetworkRequestCount();
      const rateUrl = getLastRequestUrl();
      
      setTxHistoryRequests(txCount);
      setLastTxHistoryWallet(txWallet);
      setNetworkRequests(rateCount);
      setLastRequestUrl(rateUrl);
    }, 500); // Reduced from 100ms to 500ms
    return () => clearInterval(interval);
  }, [isRefreshing]);

  // Watch for status changes after refresh to stop spinner and show errors
  const statusState = status?.state;
  const statusError = status?.error;
  useEffect(() => {
    if (isRefreshing && !isLoading) {
      setIsRefreshing(false);
      setNetworkRequests(getNetworkRequestCount());
      if (statusState === 'failed' && statusError) {
        // Capture the last endpoint that was hit when the error occurred
        const lastTxEndpoint = getLastTxHistoryWallet();
        const lastRateEndpoint = getLastRequestUrl();
        const endpointInfo = lastTxEndpoint
          ? `TX History: ${lastTxEndpoint}`
          : lastRateEndpoint
            ? `Rate: ${lastRateEndpoint}`
            : '';
        dispatch(
          showBottomNotificationModal({
            type: 'error',
            title: t('Refresh Failed'),
            message: endpointInfo
              ? `${endpointInfo}\n\n${statusError}`
              : statusError,
            enableBackdropDismiss: true,
            actions: [
              {
                text: t('OK'),
                action: () => {},
                primary: true,
              },
            ],
          }),
        );
      }
    }
  }, [isRefreshing, isLoading, statusState, statusError, dispatch, t]);

  const fiatPoints = useMemo(() => data || [], [data]);
  const cryptoPoints = useMemo(() => cryptoTimeline || [], [cryptoTimeline]);
  
  // Debug info for rate enrichment
  const walletInfo = useMemo(() => {
    if (entity.type === 'wallet' && walletId) {
      const allWallets = Object.values(keys).flatMap((key: any) => key.wallets || []);
      const wallet = findWalletById(allWallets, walletId);
      return wallet ? {
        currencyAbbreviation: wallet.currencyAbbreviation,
        chain: wallet.chain,
      } : null;
    }
    return null;
  }, [entity.type, walletId, keys]);
  
  const debugInfo = useMemo(() => {
    const firstPoint = cryptoPoints[0];
    const lastPoint = cryptoPoints[cryptoPoints.length - 1];
    const hasQuoteRate = firstPoint?.quoteRate != null;
    const hasDelta = firstPoint?.delta != null;
    return {
      entityType: entity.type,
      cryptoPointsCount: cryptoPoints.length,
      firstPointHasQuoteRate: hasQuoteRate,
      firstPointQuoteRate: firstPoint?.quoteRate,
      firstPointHasDelta: hasDelta,
      unitToSatoshi,
      statusState: status?.state,
      currencyAbbreviation: walletInfo?.currencyAbbreviation,
      chain: walletInfo?.chain,
      lastDeltaRaw: lastPoint?.delta,
      lastDeltaConverted: lastPoint?.delta != null ? lastPoint.delta / unitToSatoshi : null,
    };
  }, [cryptoPoints, entity.type, unitToSatoshi, status, walletInfo]);

  const scrollToTop = useCallback(() => {
    const listRef = viewMode === 'fiat' ? fiatListRef : cryptoListRef;
    if (listRef.current) {
      listRef.current.scrollToOffset({offset: 0, animated: true});
      haptic('impactLight');
    }
  }, [viewMode]);

  const scrollToBottom = useCallback(() => {
    const listRef = viewMode === 'fiat' ? fiatListRef : cryptoListRef;
    const dataLength = viewMode === 'fiat' ? fiatPoints.length : cryptoPoints.length;
    if (listRef.current && dataLength > 0) {
      listRef.current.scrollToEnd({animated: true});
      haptic('impactLight');
    }
  }, [viewMode, fiatPoints.length, cryptoPoints.length]);

  const copyToClipboard = useCallback(() => {
    let csv: string;
    if (viewMode === 'fiat') {
      // Check if we have breakdown data (key/portfolio scope)
      const hasBreakdown = fiatPoints.some(p => p.breakdown && p.breakdown.length > 0);
      if (hasBreakdown) {
        csv = 'timestamp,date,totalQuoteValue,quoteCurrency,walletName,walletCurrency,chain,walletQuoteValue,walletCryptoAmount\n';
        csv += fiatPoints
          .flatMap(p => {
            if (p.breakdown && p.breakdown.length > 0) {
              return p.breakdown.map(b =>
                `${p.timestamp},"${moment(p.timestamp).format('lll')}",${p.quoteValue},${p.quoteCurrency},"${b.walletName || ''}",${b.currencyAbbreviation},${b.chain},${b.quoteValue},${b.cryptoAmount}`,
              );
            }
            return [`${p.timestamp},"${moment(p.timestamp).format('lll')}",${p.quoteValue},${p.quoteCurrency},,,,${p.cryptoAmount}`];
          })
          .join('\n');
      } else {
        csv = 'timestamp,date,quoteValue,quoteCurrency,quoteRate,cryptoAmount\n';
        csv += fiatPoints
          .map(p =>
            `${p.timestamp},"${moment(p.timestamp).format('lll')}",${p.quoteValue},${p.quoteCurrency},${p.quoteRate ?? ''},${p.cryptoAmount}`,
          )
          .join('\n');
      }
    } else {
      csv = 'timestamp,date,balance,fiatValue,delta,fiatDelta,action,quoteRate,runningBreakeven,fiatGain,memo\n';
      csv += cryptoPoints
        .map(p => {
          // Handle memo that might be an object (legacy cached data) or string
          const memoText = typeof p.memo === 'string'
            ? p.memo
            : (p.memo as any)?.body || '';
          // Calculate fiat values: (smallest unit / unitToSatoshi) * rate
          const fiatValue = p.quoteRate != null ? (p.amount / unitToSatoshi) * p.quoteRate : '';
          const fiatDelta = p.quoteRate != null && p.delta != null ? (p.delta / unitToSatoshi) * p.quoteRate : '';
          const fiatGain = typeof fiatValue === 'number' && p.runningBreakeven != null ? fiatValue - p.runningBreakeven : '';
          const balance = p.amount / unitToSatoshi;
          // Use toFixed to avoid -0 display for small negative numbers
          const delta = p.delta != null ? Number((p.delta / unitToSatoshi).toFixed(18)) : '';
          return `${p.timestamp},"${moment(p.timestamp).format('lll')}",${balance},${fiatValue},${delta},${fiatDelta},${p.action ?? ''},${p.quoteRate ?? ''},${p.runningBreakeven ?? ''},${fiatGain},"${memoText.replace(/"/g, '""')}"`;
        })
        .join('\n');
    }
    Clipboard.setString(csv);
    haptic('impactLight');
  }, [viewMode, fiatPoints, cryptoPoints, unitToSatoshi]);

  // Convert data to chart format {date, value}
  const fiatChartData = useMemo(
    () =>
      fiatPoints.map(p => ({
        date: new Date(p.timestamp),
        value: p.quoteValue,
      })),
    [fiatPoints],
  );

  // For react-native-graph (fiat)
  const fiatGraphData = fiatChartData;

  // For react-native-gifted-charts step chart (crypto)
  // Format: {value: number, onPress: () => void}[]
  const [selectedCryptoPoint, setSelectedCryptoPoint] = useState<{
    value: number;
    timestamp: number;
  } | null>(null);

  const cryptoStepChartData = useMemo(
    () =>
      cryptoPoints.map((p, index) => ({
        value: p.amount,
        onPress: () => {
          setSelectedCryptoPoint({value: p.amount, timestamp: p.timestamp});
          haptic('impactLight');
        },
      })),
    [cryptoPoints],
  );

  const onPointSelected = useCallback((p: GraphPoint) => {
    setSelectedPoint(p);
    haptic('impactLight');
  }, []);

  const onGestureEnd = useCallback(() => {
    setSelectedPoint(null);
    haptic('impactLight');
  }, []);

  // Use appropriate data based on view mode
  const listData = viewMode === 'fiat' ? fiatPoints : cryptoPoints;

  const renderFiatItem = ({item}: {item: BalancePoint}) => (
    <SeriesItem>
      <Small>{formatTimestamp(item.timestamp)}</Small>
      <QuoteValue>{formatQuoteValue(item.quoteValue, item.quoteCurrency)}</QuoteValue>
      {item.quoteRate != null && (
        <RateText>
          {formatQuoteValue(item.quoteRate, item.quoteCurrency)} {t('per unit')}
        </RateText>
      )}
      {!item.breakdown && (
        <BreakdownText>{item.cryptoAmount.toLocaleString()} sats</BreakdownText>
      )}
      {item.breakdown && item.breakdown.length > 0 && (
        <View style={{marginTop: 8, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: LuckySevens}}>
          {item.breakdown.map((contrib: WalletContribution, idx: number) => (
            <TouchableOpacity
              key={idx}
              style={{marginBottom: 4, paddingVertical: 4}}
              onPress={() => {
                haptic('impactLight');
                navigation.navigate(WalletScreens.WALLET_DETAILS, {
                  walletId: contrib.walletId,
                });
              }}>
              <Small style={{fontWeight: '600', color: ProgressBlue}}>
                {contrib.walletName || contrib.currencyAbbreviation.toUpperCase()} ({contrib.chain}) →
              </Small>
              <BreakdownText>
                {formatQuoteValue(contrib.quoteValue, item.quoteCurrency)} • {contrib.cryptoAmount.toLocaleString()} sats
              </BreakdownText>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </SeriesItem>
  );

  const renderCryptoItem = ({item}: {item: CryptoCheckpoint}) => {
    // Handle memo that might be an object (legacy cached data) or string
    const memoText = typeof item.memo === 'string'
      ? item.memo
      : (item.memo as any)?.body || null;

    // Calculate fiat value: (smallest unit / unitToSatoshi) * rate
    const fiatValue = item.quoteRate != null
      ? (item.amount / unitToSatoshi) * item.quoteRate
      : null;

    return (
      <SeriesItem>
        <Small>{formatTimestamp(item.timestamp)}</Small>
        <QuoteValue>{(item.amount / unitToSatoshi).toLocaleString()}</QuoteValue>
        {fiatValue != null && (
          <QuoteValue>
            {formatQuoteValue(fiatValue, quoteCurrency)}
          </QuoteValue>
        )}
        {item.action && (
          <BreakdownText style={{textTransform: 'capitalize'}}>
            {item.action}
          </BreakdownText>
        )}
        {item.quoteRate != null && (
          <RateText>
            @ {formatQuoteValue(item.quoteRate, quoteCurrency)}
          </RateText>
        )}
        {item.runningBreakeven != null && (
          <RateText>
            {t('Breakeven')}: {formatQuoteValue(item.runningBreakeven, quoteCurrency)}
          </RateText>
        )}
        {memoText && <RateText>{memoText}</RateText>}
      </SeriesItem>
    );
  };

  // Display value for selected point or latest value
  const displayValue = useMemo(() => {
    if (viewMode === 'fiat' && selectedPoint) {
      return formatQuoteValue(selectedPoint.value, fiatPoints[0]?.quoteCurrency || 'USD');
    }
    if (viewMode === 'crypto' && selectedCryptoPoint) {
      return (selectedCryptoPoint.value / unitToSatoshi).toLocaleString();
    }
    if (viewMode === 'fiat' && fiatPoints.length) {
      const latest = fiatPoints[fiatPoints.length - 1];
      return formatQuoteValue(latest.quoteValue, latest.quoteCurrency);
    }
    if (viewMode === 'crypto' && cryptoPoints.length) {
      return (cryptoPoints[cryptoPoints.length - 1].amount / unitToSatoshi).toLocaleString();
    }
    return '--';
  }, [selectedPoint, selectedCryptoPoint, viewMode, fiatPoints, cryptoPoints, unitToSatoshi]);

  const displayDate = useMemo(() => {
    if (viewMode === 'fiat' && selectedPoint) {
      return moment(selectedPoint.date).format('lll');
    }
    if (viewMode === 'crypto' && selectedCryptoPoint) {
      return moment(selectedCryptoPoint.timestamp).format('lll');
    }
    return null;
  }, [viewMode, selectedPoint, selectedCryptoPoint]);

  const headerComponent = (
    <>
      <SegmentContainer>
        <TabButton
          active={viewMode === 'fiat'}
          onPress={() => setViewMode('fiat')}>
          {t('Fiat')} ({fiatPoints.length})
        </TabButton>
        <TabButton
          active={viewMode === 'crypto'}
          onPress={() => setViewMode('crypto')}>
          {t('Crypto')} ({cryptoPoints.length})
        </TabButton>
      </SegmentContainer>

      {/* Chart */}
      <ChartContainer>
        {isLoading ? (
          <LoadingContainer>
            <ActivityIndicator color={ProgressBlue} />
          </LoadingContainer>
        ) : viewMode === 'fiat' && fiatGraphData.length > 1 ? (
          <View>
            <Paragraph style={{textAlign: 'center', marginBottom: 8}}>
              {displayValue}
            </Paragraph>
            {displayDate && (
              <Small style={{textAlign: 'center', marginBottom: 8}}>
                {displayDate}
              </Small>
            )}
            <LineGraph
              points={fiatGraphData}
              animated={true}
              color={ProgressBlue}
              gradientFillColors={[
                ProgressBlue + '40',
                theme.dark ? 'transparent' : White,
              ]}
              enablePanGesture={true}
              panGestureDelay={100}
              onPointSelected={onPointSelected}
              onGestureEnd={onGestureEnd}
              style={{width: WIDTH, height: 120}}
            />
          </View>
        ) : viewMode === 'crypto' && cryptoStepChartData.length > 1 ? (
          <View>
            <Paragraph style={{textAlign: 'center', marginBottom: 8}}>
              {displayValue}
            </Paragraph>
            {displayDate && (
              <Small style={{textAlign: 'center', marginBottom: 8}}>
                {displayDate}
              </Small>
            )}
            <LineChart
              data={cryptoStepChartData}
              stepChart
              width={WIDTH - 40}
              height={120}
              color={ProgressBlue}
              thickness={2}
              dataPointsColor={ProgressBlue}
              dataPointsRadius={4}
              hideYAxisText
              hideAxesAndRules
              adjustToWidth
              curved={false}
            />
          </View>
        ) : (
          <LoadingContainer>
            <Small>{t('Not enough data for chart')}</Small>
          </LoadingContainer>
        )}
      </ChartContainer>

      <StatusContainer>
        <Paragraph>{displayName || (keyId ? t('Key') : t('Wallet'))}</Paragraph>
        <StatusRow>
          <StatusLabel>{t('Status')}</StatusLabel>
          <StatusValue>
            {status?.state ? status.state.toUpperCase() : t('IDLE')}
          </StatusValue>
        </StatusRow>
        {breakeven?.breakeven != null ? (
          <Paragraph style={{marginTop: 4}}>
            {t('Breakeven')}: {formatQuoteValue(breakeven.breakeven, quoteCurrency)}
          </Paragraph>
        ) : null}
        <Small style={{marginTop: 4, color: LuckySevens}}>
          Debug: coin={debugInfo.currencyAbbreviation}/{debugInfo.chain}, 
          pts={debugInfo.cryptoPointsCount}, hasRate={String(debugInfo.firstPointHasQuoteRate)}, 
          lastDeltaRaw={debugInfo.lastDeltaRaw}, lastDeltaConv={debugInfo.lastDeltaConverted}
        </Small>
        <Paragraph style={{marginTop: 4}}>
          {t('Timeframe')}: {timeframe}
        </Paragraph>
        <Small>{listData.length} {t('data points')}</Small>
        {txHistoryRequests !== null && txHistoryRequests >= 0 && (
          <Small>
            {t('TX history requests')}: {txHistoryRequests}{isRefreshing ? '...' : ''}
          </Small>
        )}
        {lastTxHistoryWallet ? (
          <Small numberOfLines={1} ellipsizeMode="middle" style={{opacity: 0.7}}>
            {lastTxHistoryWallet}
          </Small>
        ) : null}
        {networkRequests !== null && networkRequests >= 0 && (
          <Small>
            {t('Rate requests')}: {networkRequests}{isRefreshing ? '...' : ''}
          </Small>
        )}
        {lastRequestUrl ? (
          <Small numberOfLines={1} ellipsizeMode="middle" style={{opacity: 0.7}}>
            {lastRequestUrl}
          </Small>
        ) : null}
        {status?.lastUpdated ? (
          <Small>
            {t('Last updated {{time}}', {
              time: moment(status.lastUpdated).fromNow(),
            })}
          </Small>
        ) : null}
        {status?.error ? <ErrorText>{status.error}</ErrorText> : null}
      </StatusContainer>
    </>
  );

  const emptyComponent = (
    <EmptyState>
      <Paragraph style={{textAlign: 'center'}}>
        {isLoading
          ? t('Loading balance series...')
          : t('No balance history yet for this timeframe.')}
      </Paragraph>
    </EmptyState>
  );

  const showScrollButton = listData.length > 0;

  return (
    <Container>
      {viewMode === 'fiat' ? (
        <FlatList
          ref={fiatListRef}
          data={fiatPoints}
          keyExtractor={item => `${item.timestamp}`}
          renderItem={renderFiatItem}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
          }
          ListHeaderComponent={headerComponent}
          ListEmptyComponent={emptyComponent}
          contentContainerStyle={fiatPoints.length === 0 ? {flex: 1} : undefined}
        />
      ) : (
        <FlatList
          ref={cryptoListRef}
          data={cryptoPoints}
          keyExtractor={item => `${item.timestamp}`}
          renderItem={renderCryptoItem}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
          }
          ListHeaderComponent={headerComponent}
          ListEmptyComponent={emptyComponent}
          contentContainerStyle={cryptoPoints.length === 0 ? {flex: 1} : undefined}
        />
      )}
      {showScrollButton && (
        <ScrollButtonContainer>
          <ScrollButton onPress={handleRefresh} disabled={isRefreshing}>
            <RefreshSvg width={20} height={20} fill={White} style={{opacity: isRefreshing ? 0.5 : 1}} />
          </ScrollButton>
          <ScrollButton onPress={copyToClipboard}>
            <CopySvg width={20} height={20} fill={White} />
          </ScrollButton>
          <ScrollButton onPress={scrollToTop}>
            <ChevronUpSvg width={20} height={20} fill={White} />
          </ScrollButton>
          <ScrollButton onPress={scrollToBottom}>
            <ChevronDownSvg width={20} height={20} fill={White} />
          </ScrollButton>
        </ScrollButtonContainer>
      )}
    </Container>
  );
};

export default WalletBalanceSeriesScreen;
