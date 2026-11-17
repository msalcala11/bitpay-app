import {Alert, Linking, AppState} from 'react-native';
import {checkNotifications, RESULTS} from 'react-native-permissions';
import {t} from 'i18next';

export const notificationPermissionAllowed = (status: string) =>
  status === RESULTS.GRANTED || status === RESULTS.LIMITED;
export type PermissionPromptResult = 'allowed' | 'denied' | 'dismissed';
export const showNotificationsDisabled = (
  onResult?: (result: PermissionPromptResult) => void,
) => {
  let answered = false;
  const answer = (result: PermissionPromptResult) => {
    if (!answered) {
      answered = true;
      onResult?.(result);
    }
  };
  Alert.alert(
    t('Notifications Disabled'),
    t(
      'If you want to get important updates on your account, new features, promos and more, go to Settings and tap Allow Notifications.',
    ),
    [
      {text: t('Cancel'), style: 'cancel', onPress: () => answer('denied')},
      {
        text: t('Change Settings'),
        onPress: () => {
          let left = false;
          const subscription = AppState.addEventListener(
            'change',
            async state => {
              if (state !== 'active') {
                left = true;
              } else if (left) {
                subscription.remove();
                try {
                  const {status} = await checkNotifications();
                  answer(
                    notificationPermissionAllowed(status)
                      ? 'allowed'
                      : 'denied',
                  );
                } catch {
                  answer('dismissed');
                }
              }
            },
          );
          Linking.openSettings().catch(() => {
            subscription.remove();
            answer('dismissed');
          });
        },
      },
    ],
    {onDismiss: () => answer('dismissed')},
  );
};
