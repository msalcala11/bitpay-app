import React, {useMemo, useState} from 'react';
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

  return (
    <SettingsContainer>
      <ScrollContainer>
        <HeaderTitle>
          <SettingTitle>{t('Wallet')}</SettingTitle>
        </HeaderTitle>
        <Setting>
          <SettingTitle>{walletId}</SettingTitle>
        </Setting>

        <HeaderTitle>
          <SettingTitle>{t('Intervals')}</SettingTitle>
        </HeaderTitle>
        <Setting style={{flexDirection: 'column', alignItems: 'flex-start'}}>
          {intervals.length ? (
            <React.Fragment>
              <Setting style={{flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 4}}>
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
          <SettingTitle>{t('Cursor JSON')}</SettingTitle>
        </HeaderTitle>
        <JsonText selectable>{json || t('No cursor data')}</JsonText>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default PortfolioWalletCursorDebug;
