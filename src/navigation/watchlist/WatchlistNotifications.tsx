import React, {useEffect} from 'react';
import {View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import Banner from '../../components/banner/Banner';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {
  selectAlertContext,
  selectAlertsAvailable,
  selectAlertsDeliverable,
} from '../../store/watchlist/watchlist.selectors';
import {
  consumeAlertNotificationPrompt,
  fixAlertNotifications,
} from './notificationPrompts.effects';

export const WatchlistNotificationsBanner = () => {
  const {t} = useTranslation();
  const navigation = useNavigation<any>();
  const dispatch = useAppDispatch();
  const visible = useAppSelector(
    state =>
      selectAlertsAvailable(state) &&
      !selectAlertsDeliverable(state) &&
      Object.keys(selectAlertContext(state)?.alerts || {}).length > 0,
  );
  if (!visible) {
    return null;
  }
  return (
    <View style={{marginHorizontal: 12, marginTop: 8, marginBottom: 12}}>
      <Banner
        type="info"
        title={t('Price alerts are off')}
        description={t(
          'Turn on notifications to get an alert when a coin on your watchlist moves.',
        )}
        link={{
          text: t('Turn On Notifications'),
          onPress: () => {
            void dispatch(
              fixAlertNotifications('Watchlist', false, () =>
                navigation.navigate('PushNotifications'),
              ),
            );
          },
        }}
      />
    </View>
  );
};
export const AlertNotificationPrompt = () => {
  const dispatch = useAppDispatch();
  const navigation = useNavigation<any>();
  const context = useAppSelector(
    state => state.WATCHLIST.pendingNotificationPrompt,
  );
  useEffect(() => {
    if (!context) {
      return;
    }
    const pending = dispatch(consumeAlertNotificationPrompt());
    if (pending) {
      void dispatch(
        fixAlertNotifications(pending, true, () =>
          navigation.navigate('PushNotifications'),
        ),
      );
    }
  }, [context, dispatch, navigation]);
  return null;
};
