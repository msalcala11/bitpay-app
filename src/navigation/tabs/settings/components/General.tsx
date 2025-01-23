import React, {useEffect, useState, useLayoutEffect} from 'react';
import Button from '../../../../components/button/Button';
import AngleRight from '../../../../../assets/img/angle-right.svg';
import ToggleSwitch from '../../../../components/toggle-switch/ToggleSwitch';
import {AppActions} from '../../../../store/app';
import {showBottomNotificationModal} from '../../../../store/app/app.actions';
import {resetAllSettings} from '../../../../store/app/app.effects';
import {sleep} from '../../../../utils/helper-methods';
import {useTheme} from '@react-navigation/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useAppSelector} from '../../../../utils/hooks/useAppSelector';
import {RootState} from '../../../../store';
import {useAppDispatch} from '../../../../utils/hooks/useAppDispatch';
import {useTranslation} from 'react-i18next';
import {SettingsContainer} from '../SettingsRoot';
import {LanguageList} from '../../../../constants/LanguageSelectionList';
import {
  ActiveOpacity,
  Hr,
  Setting,
  SettingTitle,
} from '../../../../components/styled/Containers';
import styled from 'styled-components/native';
import {HeaderBackButton} from '@react-navigation/elements';
import {baseNativeHeaderBackButtonProps} from '../../../../constants/NavigationOptions';
import {SettingsDetailsParamList} from '../SettingsDetails';

const SettingsComponent = styled.ScrollView`
  padding: 10px 0;
`;

type Props = NativeStackScreenProps<SettingsDetailsParamList, 'General'>;

const General: React.FC<Props> = ({navigation}) => {
  const colorScheme = useAppSelector(({APP}: RootState) => APP.colorScheme);
  const theme = useTheme();
  const showPortfolioValue = useAppSelector(
    ({APP}: RootState) => APP.showPortfolioValue,
  );
  const hideAllBalances = useAppSelector(
    ({APP}: RootState) => APP.hideAllBalances,
  );
  const selectedAltCurrency = useAppSelector(
    ({APP}: RootState) => APP.defaultAltCurrency,
  );
  const appLanguage = useAppSelector(({APP}) => APP.defaultLanguage);
  const [appLanguageName, setAppLanguageName] = useState('');

  const dispatch = useAppDispatch();
  const {t} = useTranslation();

  useEffect(() => {
    LanguageList.forEach(lng => {
      if (lng.isoCode === appLanguage) {
        setAppLanguageName(lng.name);
      }
    });
  }, [appLanguage]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <HeaderBackButton
          onPress={() => navigation.goBack()}
          {...baseNativeHeaderBackButtonProps}
        />
      ),
    });
  }, [navigation, theme, t]);

  return (
    <SettingsComponent>
      <Setting
        activeOpacity={ActiveOpacity}
        onPress={() => navigation.navigate('Theme')}>
        <SettingTitle>{t('Theme')}</SettingTitle>
        <Button
          buttonType={'pill'}
          onPress={() => navigation.navigate('Theme')}>
          {colorScheme === 'light'
            ? t('Light Mode')
            : colorScheme === 'dark'
            ? t('Dark Mode')
            : t('System Default')}
        </Button>
      </Setting>
      <Hr />
      {/*----------------------------------------------------------------------*/}
      <Setting
        activeOpacity={ActiveOpacity}
        onPress={() => navigation.navigate('Customize Home')}>
        <SettingTitle>{t('Customize Home')}</SettingTitle>
        <AngleRight />
      </Setting>
      <Hr />
      {/*----------------------------------------------------------------------*/}
      <Setting activeOpacity={1}>
        <SettingTitle>{t('Show Portfolio')}</SettingTitle>
        <ToggleSwitch
          onChange={value => dispatch(AppActions.showPortfolioValue(value))}
          isEnabled={showPortfolioValue}
        />
      </Setting>
      <Hr />
      {/*----------------------------------------------------------------------*/}
      <Setting activeOpacity={1}>
        <SettingTitle>{t('Hide All Balances')}</SettingTitle>
        <ToggleSwitch
          onChange={value => dispatch(AppActions.toggleHideAllBalances(value))}
          isEnabled={hideAllBalances}
        />
      </Setting>
      <Hr />
      {/*----------------------------------------------------------------------*/}
      <Setting
        activeOpacity={ActiveOpacity}
        onPress={() => navigation.navigate('Display Currency')}>
        <SettingTitle>{t('Display Currency')}</SettingTitle>
        <Button
          buttonType={'pill'}
          onPress={() => navigation.navigate('Display Currency')}>
          {selectedAltCurrency.name}
        </Button>
      </Setting>
      <Hr /> 
      {/*----------------------------------------------------------------------*/}
      <Setting
        activeOpacity={ActiveOpacity}
        onPress={() => navigation.navigate('Language')}>
        <SettingTitle>{t('Language')}</SettingTitle>
        <Button
          buttonType={'pill'}
          onPress={() => navigation.navigate('Language')}>
          {appLanguageName}
        </Button>
      </Setting>
      <Hr />
      {/*----------------------------------------------------------------------*/}
      <Setting
        activeOpacity={ActiveOpacity}
        onPress={() =>
          dispatch(
            showBottomNotificationModal({
              type: 'warning',
              title: t('Reset all settings'),
              message: t('Are you sure you want to reset all settings?'),
              enableBackdropDismiss: true,
              actions: [
                {
                  text: t('RESET'),
                  action: async () => {
                    dispatch(resetAllSettings());
                    await sleep(400);
                    dispatch(
                      showBottomNotificationModal({
                        type: 'success',
                        title: t('Reset complete'),
                        message: t('All settings have been reset.'),
                        enableBackdropDismiss: true,
                        actions: [
                          {
                            text: t('OK'),
                            action: () => null,
                            primary: true,
                          },
                        ],
                      }),
                    );
                  },
                  primary: true,
                },
                {
                  text: t('CANCEL'),
                  action: () => {},
                  primary: true,
                },
              ],
            }),
          )
        }>
        <SettingTitle>{t('Reset All Settings')}</SettingTitle>
      </Setting>
    </SettingsComponent>
  );
};

export default General;
