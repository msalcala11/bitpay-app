import React, {useCallback, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {selectNotificationsAccepted} from '../../../../../store/app/app.selectors';
import {View, ScrollView, StyleSheet} from 'react-native';
import {
  Hr,
  ScreenGutter,
  SettingTitle,
} from '../../../../../components/styled/Containers';
import ToggleSwitch from '../../../../../components/toggle-switch/ToggleSwitch';
import {SettingsContainer} from '../../SettingsRoot';
import {useAppDispatch, useAppSelector} from '../../../../../utils/hooks';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {AppEffects} from '../../../../../store/app';
import {showNotificationsDisabled} from '../notificationPermission';
import {setPriceAlertsEnabled} from '../../../../../store/watchlist/watchlist.effects';
import {selectAlertsAvailable} from '../../../../../store/watchlist/watchlist.selectors';
import {showPriceAlertError} from '../../../../watchlist/watchlistUi.effects';

const styles = StyleSheet.create({
  settingsComponent: {
    flex: 1,
    marginTop: 15,
    paddingHorizontal: parseInt(ScreenGutter, 10),
  },
  settingRow: {
    flexGrow: 1,
    justifyContent: 'center',
    flexDirection: 'column',
    paddingVertical: 8,
  },
  settingRowContainer: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 58,
  },
  settingRowContent: {
    flex: 1,
  },
  settingTitle: {
    flexGrow: 0,
  },
});

const SettingsComponent = ({
  style,
  ...rest
}: React.ComponentProps<typeof ScrollView>) => (
  <ScrollView style={[styles.settingsComponent, style]} {...rest} />
);

const SettingRow = ({style, ...rest}: React.ComponentProps<typeof View>) => (
  <View style={[styles.settingRow, style]} {...rest} />
);

const SettingRowContainer = ({
  style,
  ...rest
}: React.ComponentProps<typeof TouchableOpacity>) => (
  <TouchableOpacity style={[styles.settingRowContainer, style]} {...rest} />
);

const PushNotifications = () => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const notificationsAccepted = useAppSelector(selectNotificationsAccepted);
  const [pendingPreference, setPendingPreference] = useState<boolean | null>(
    null,
  );
  const isUpdatingRef = useRef(false);
  const pushNotifications = pendingPreference ?? notificationsAccepted;

  const priceAlertsEnabled = useAppSelector(
    state => state.WATCHLIST.priceAlertsEnabled,
  );
  const alertsAvailable = useAppSelector(selectAlertsAvailable);
  const [updatingAlerts, setUpdatingAlerts] = useState(false);
  const alertBusy = useRef(false);
  const openSettings = useCallback(() => showNotificationsDisabled(), []);
  const changeAlerts = async () => {
    if (alertBusy.current || !pushNotifications) {
      return;
    }
    alertBusy.current = true;
    setUpdatingAlerts(true);
    try {
      await dispatch(setPriceAlertsEnabled(!priceAlertsEnabled));
    } catch {
      dispatch(showPriceAlertError());
    } finally {
      alertBusy.current = false;
      setUpdatingAlerts(false);
    }
  };

  const onPress = useCallback(async () => {
    if (isUpdatingRef.current) {
      return;
    }

    const nextPreference = !pushNotifications;
    isUpdatingRef.current = true;
    setPendingPreference(nextPreference);

    try {
      const systemEnabled = nextPreference
        ? await AppEffects.checkNotificationsPermissions()
        : true;
      const permissionGranted =
        systemEnabled ||
        (nextPreference
          ? await AppEffects.requestNotificationsPermissions()
          : true);

      if (permissionGranted) {
        dispatch(AppEffects.setNotifications(nextPreference));
      } else {
        openSettings();
      }
    } finally {
      isUpdatingRef.current = false;
      setPendingPreference(null);
    }
  }, [dispatch, openSettings, pushNotifications]);

  return (
    <SettingsContainer>
      <SettingsComponent>
        <View>
          <SettingRowContainer
            disabled={pendingPreference !== null}
            onPress={onPress}>
            <SettingRow style={styles.settingRowContent}>
              <SettingTitle style={styles.settingTitle}>
                {t('Push Notifications')}
              </SettingTitle>
            </SettingRow>
            <ToggleSwitch onChange={onPress} isEnabled={pushNotifications} />
          </SettingRowContainer>
          <Hr />
          {alertsAvailable ? (
            <>
              <SettingRowContainer
                accessibilityRole="switch"
                accessibilityState={{
                  checked: priceAlertsEnabled,
                  disabled: !pushNotifications || updatingAlerts,
                }}
                accessibilityLabel={t('Price Alerts')}
                disabled={!pushNotifications || updatingAlerts}
                onPress={changeAlerts}
                style={{opacity: pushNotifications ? 1 : 0.5}}>
                <SettingRow style={styles.settingRowContent}>
                  <SettingTitle style={styles.settingTitle}>
                    {t('Price Alerts')}
                  </SettingTitle>
                </SettingRow>
                <ToggleSwitch
                  onChange={changeAlerts}
                  isEnabled={priceAlertsEnabled}
                  isDisabled={!pushNotifications || updatingAlerts}
                />
              </SettingRowContainer>
              <Hr />
            </>
          ) : null}
        </View>
      </SettingsComponent>
    </SettingsContainer>
  );
};

export default React.memo(PushNotifications);
