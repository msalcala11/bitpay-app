import {Alert, AppState, Linking} from 'react-native';
import i18n from 'i18next';
import {URL} from '../constants';
import {safeVaultError, vaultDiagnostic} from './vault-diagnostics';

// One failed bootstrap owns one controller. Browser-request completion is not
// foreground return: openURL can resolve before Android pauses the Activity.
export const vaultStartupAlert = (error: unknown, retry: () => void) => {
  const diagnostic = vaultDiagnostic(safeVaultError(error))!;
  const id = `${diagnostic.code}/${diagnostic.phase}`;
  let disposed = false;
  let visible = false;
  let waitingForSupport = false;
  let departed = false;
  let presentationId = 0;
  let supportId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const returned = () => {
    if (disposed || !waitingForSupport) return;
    waitingForSupport = false;
    supportId++; // Ignore a browser result arriving after foreground return.
    cancelTimer();
    // Native Activity resume/dialog dismissal must finish before showing again.
    timer = setTimeout(() => {
      timer = undefined;
      present();
    }, 0);
  };
  const present = () => {
    if (disposed || visible || waitingForSupport) return;
    visible = true;
    const shown = ++presentationId;
    const current = () => !disposed && shown === presentationId;
    Alert.alert(
      i18n.t('Wallet data could not be opened'),
      i18n.t('VaultStartupGuidance', {id}),
      [
        {
          text: i18n.t('Retry'),
          onPress: () => {
            if (!current()) return;
            dispose();
            retry();
          },
        },
        {
          text: i18n.t('Help & Support'),
          onPress: () => {
            if (!current()) return;
            visible = false;
            presentationId++;
            waitingForSupport = true;
            departed = false;
            const request = ++supportId;
            Promise.resolve()
              .then(() => Linking.openURL(URL.HELP_AND_SUPPORT))
              .then(
                () => {
                  if (disposed || request !== supportId) return;
                  // Never queue a speculative Alert while the browser is opening.
                  if (departed && AppState.currentState === 'active')
                    returned();
                },
                () => {
                  if (disposed || request !== supportId) return;
                  if (!departed || AppState.currentState === 'active')
                    returned();
                },
              );
          },
        },
      ],
      {cancelable: false},
    );
  };
  const subscription = AppState.addEventListener('change', state => {
    if (disposed || !waitingForSupport) return;
    if (state !== 'active') departed = true;
    else if (departed) returned();
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    presentationId++;
    supportId++;
    cancelTimer();
    subscription.remove();
  };
  present();
  return dispose;
};
