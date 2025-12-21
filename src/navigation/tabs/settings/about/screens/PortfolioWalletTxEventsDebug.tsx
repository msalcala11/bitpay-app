import React, {useMemo} from 'react';
import styled from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {SettingsContainer} from '../../SettingsRoot';
import {
  Hr,
  ScreenGutter,
  Setting,
  SettingTitle,
} from '../../../../../components/styled/Containers';
import {Black, Feather, LightBlack, White} from '../../../../../styles/colors';
import Button from '../../../../../components/button/Button';
import {useAppSelector} from '../../../../../utils/hooks';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {PortfolioTxEvent} from '../../../../../store/portfolio/portfolio.types';

const ScrollContainer = styled.ScrollView``;

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
  AboutScreens.PORTFOLIO_WALLET_TX_EVENTS_DEBUG
>;

const PortfolioWalletTxEventsDebug: React.FC<Props> = ({route}) => {
  const {t} = useTranslation();
  const {walletId} = route.params;

  const events = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.txEventsByWalletId[walletId] || [],
  );

  const derived = useMemo(() => {
    const total = events.length;
    const confirmed = events.filter((e: PortfolioTxEvent) => e.confirmed).length;
    const byCategory = events.reduce(
      (acc: Record<string, number>, e: PortfolioTxEvent) => {
        acc[e.category] = (acc[e.category] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const json = (() => {
      try {
        return JSON.stringify(events, null, 2);
      } catch (_) {
        return '';
      }
    })();

    return {total, confirmed, byCategory, json};
  }, [events]);

  return (
    <SettingsContainer>
      <ScrollContainer>
        <HeaderTitle>
          <SettingTitle>{t('Counts')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>{t('Wallet ID')}</SettingTitle>
          <Button buttonType="pill">{walletId}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('Total Events')}</SettingTitle>
          <Button buttonType="pill">{derived.total}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('Confirmed Events')}</SettingTitle>
          <Button buttonType="pill">{derived.confirmed}</Button>
        </Setting>
        <Hr />
        <Setting>
          <SettingTitle>{t('By Category')}</SettingTitle>
          <Button buttonType="pill">{JSON.stringify(derived.byCategory)}</Button>
        </Setting>

        <HeaderTitle>
          <SettingTitle>{t('Events JSON')}</SettingTitle>
        </HeaderTitle>
        <JsonText selectable>{derived.json}</JsonText>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default PortfolioWalletTxEventsDebug;
