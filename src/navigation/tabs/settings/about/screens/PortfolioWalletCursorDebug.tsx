import React, {useMemo, useState} from 'react';
import {View} from 'react-native';
import {LineGraph} from 'react-native-graph';
import {useNavigation} from '@react-navigation/native';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {SettingsContainer} from '../../SettingsRoot';
import {
  Hr,
  ScreenGutter,
  Setting,
  SettingTitle,
} from '../../../../../components/styled/Containers';
import Button from '../../../../../components/button/Button';
import {Black, Feather, LightBlack, White} from '../../../../../styles/colors';
import {useAppSelector} from '../../../../../utils/hooks';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {PortfolioInterval} from '../../../../../store/portfolio/portfolio.types';
import {WalletGroupParamList} from '../../../../wallet/WalletGroup';
import Clipboard from '@react-native-clipboard/clipboard';

const ScrollContainer = styled.ScrollView.attrs({
  contentContainerStyle: {paddingBottom: 40},
})``;

const HeaderTitle = styled(Setting)`
  margin-top: 20px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Feather)};
  padding: 0 ${ScreenGutter};
  border-bottom-width: 1px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? Black : White)};
`;

const JsonText = styled.Text`
  font-size: 12px;
  line-height: 18px;
  padding: 12px 16px;
`;

type Props = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.PORTFOLIO_WALLET_CURSOR_DEBUG
>;

const PortfolioWalletCursorDebug: React.FC<Props> = ({route}) => {
  const {t} = useTranslation();
  const {walletId} = route.params;
  const navigation = useNavigation<NativeStackNavigationProp<WalletGroupParamList>>();
  const cursorsByInterval = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.walletIntervalCursorsByWalletId[walletId] || {},
  );
  const [selectedInterval, setSelectedInterval] = useState<PortfolioInterval | null>(
    null,
  );

  const intervals = useMemo(
    () => Object.keys(cursorsByInterval) as PortfolioInterval[],
    [cursorsByInterval],
  );

  const cursor = selectedInterval
    ? cursorsByInterval[selectedInterval]
    : intervals.length
    ? cursorsByInterval[intervals[0]]
    : undefined;

  const pnlUSD = useMemo(() => {
    if (!cursor || !cursor.points?.length) {
      return null;
    }
    const first = cursor.points[0];
    const last = cursor.points[cursor.points.length - 1];
    if (first.valueUSD == null || last.valueUSD == null) {
      return null;
    }
    const startUnrealized = first.valueUSD - first.costBasisRemainingUSD;
    const endUnrealized = last.valueUSD - last.costBasisRemainingUSD;
    return endUnrealized - startUnrealized;
  }, [cursor]);

  const pnlDetail = useMemo(() => {
    if (!cursor || !cursor.points?.length) {
      return null;
    }
    const first = cursor.points[0];
    const last = cursor.points[cursor.points.length - 1];
    if (first.valueUSD == null || last.valueUSD == null) {
      return null;
    }
    return {
      startValue: first.valueUSD,
      startBasis: first.costBasisRemainingUSD,
      endValue: last.valueUSD,
      endBasis: last.costBasisRemainingUSD,
      startUnrealized: first.valueUSD - first.costBasisRemainingUSD,
      endUnrealized: last.valueUSD - last.costBasisRemainingUSD,
    };
  }, [cursor]);

  const graphPoints = useMemo(() => {
    if (!cursor?.points?.length) {
      return [];
    }
    return cursor.points
      .filter((p: typeof cursor.points[number]) => p.valueUSD != null)
      .map((p: typeof cursor.points[number]) => ({
        date: new Date(p.time * 1000),
        value: p.valueUSD as number,
      }));
  }, [cursor]);

  const json = useMemo(() => {
    if (!cursor) {
      return '';
    }
    try {
      return JSON.stringify(cursor, null, 2);
    } catch {
      return '';
    }
  }, [cursor]);

  const copyCursorCsv = () => {
    if (!cursor) {
      return;
    }
    const headers = [
      'time',
      'time_iso',
      'cryptoBalance',
      'costBasisRemainingUSD',
      'valueUSD',
    ];
    const lines = [
      headers.join(','),
      ...cursor.points.map((p: typeof cursor.points[number]) =>
        [
          p.time,
          new Date(p.time * 1000).toISOString(),
          p.cryptoBalance,
          p.costBasisRemainingUSD,
          p.valueUSD ?? '',
        ].join(','),
      ),
    ];
    Clipboard.setString(lines.join('\n'));
  };

  return (
    <SettingsContainer>
      <ScrollContainer>
        <HeaderTitle>
          <SettingTitle>{t('Wallet')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>{walletId}</SettingTitle>
          <Button
            buttonType="pill"
            onPress={() =>
              navigation.navigate('WalletDetails', {
                walletId,
              })
            }
            style={{marginTop: 8}}>
            {t('Open Wallet Details')}
          </Button>
        </Setting>

        <HeaderTitle>
          <SettingTitle>{t('Value Chart')}</SettingTitle>
        </HeaderTitle>
        <Setting
          style={{
            paddingVertical: 12,
            marginBottom: 140,
            minHeight: 200,
            width: '100%',
          }}>
          {graphPoints.length ? (
            <LineGraph
              style={{height: 220, width: '100%'}}
              points={graphPoints}
              animated
              gradientFillColors={['#7dd3fc', '#38bdf8', '#0ea5e9']}
              color="#0ea5e9"
              enablePanGesture={true}
              enableIndicator={true}
            />
          ) : (
            <SettingTitle>{t('No value data')}</SettingTitle>
          )}
        </Setting>

        <HeaderTitle>
          <SettingTitle>{t('Intervals')}</SettingTitle>
        </HeaderTitle>
        <Setting style={{flexDirection: 'column', alignItems: 'flex-start', height: 95}}>
          {intervals.length ? (
            <React.Fragment>
              <Setting
                style={{
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  paddingVertical: 11,
                  minHeight: 95,
                }}>
                {intervals.map(interval => (
                  <Button
                    key={interval}
                    buttonType="pill"
                    buttonStyle={selectedInterval === interval ? 'primary' : 'secondary'}
                    onPress={() => setSelectedInterval(interval)}
                    style={{marginRight: 8, marginBottom: 8}}>
                    {interval}
                  </Button>
                ))}
              </Setting>
            </React.Fragment>
          ) : (
            <SettingTitle>{t('No cursors found')}</SettingTitle>
          )}
        </Setting>

        <HeaderTitle>
          <SettingTitle>{t('Interval PnL (USD)')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>
            {pnlUSD == null ? t('n/a') : `${pnlUSD.toFixed(2)} USD`}
          </SettingTitle>
        </Setting>
        {pnlDetail ? (
          <View
            style={{
              width: '100%',
              paddingHorizontal: 16,
              paddingVertical: 8,
              gap: 6,
              alignItems: 'flex-start',
            }}>
            <SettingTitle>
              {t('Start Value')}: {pnlDetail.startValue.toFixed(2)} USD
            </SettingTitle>
            <SettingTitle>
              {t('Start Basis')}: {pnlDetail.startBasis.toFixed(2)} USD
            </SettingTitle>
            <SettingTitle>
              {t('Unrealized Start')}: {pnlDetail.startUnrealized.toFixed(2)} USD
            </SettingTitle>
            <View style={{height: 8}} />
            <SettingTitle>
              {t('End Value')}: {pnlDetail.endValue.toFixed(2)} USD
            </SettingTitle>
            <SettingTitle>
              {t('End Basis')}: {pnlDetail.endBasis.toFixed(2)} USD
            </SettingTitle>
            <SettingTitle>
              {t('Unrealized End')}: {pnlDetail.endUnrealized.toFixed(2)} USD
            </SettingTitle>
          </View>
        ) : null}

        <HeaderTitle>
          <SettingTitle>{t('Cursor JSON')}</SettingTitle>
          <Button
            buttonType="pill"
            onPress={copyCursorCsv}
            style={{marginTop: 8}}>
            {t('Copy as CSV')}
          </Button>
        </HeaderTitle>
        <JsonText selectable>{json || t('No cursor data')}</JsonText>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default PortfolioWalletCursorDebug;
