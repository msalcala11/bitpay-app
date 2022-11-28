import {LinkingOptions} from '@react-navigation/native';
import {useRef} from 'react';
import {Linking} from 'react-native';
import AppsFlyer from 'react-native-appsflyer';
import InAppBrowser from 'react-native-inappbrowser-reborn';
import {
  APP_CRYPTO_PREFIX,
  APP_DEEPLINK_PREFIX,
  APP_UNIVERSAL_LINK_DOMAINS,
} from '../../constants/config';
import {BitpayIdScreens} from '../../navigation/bitpay-id/BitpayIdStack';
import {CardScreens} from '../../navigation/card/CardStack';
import {BuyCryptoScreens} from '../../navigation/services/buy-crypto/BuyCryptoStack';
import {SwapCryptoScreens} from '../../navigation/services/swap-crypto/SwapCryptoStack';
import {CoinbaseScreens} from '../../navigation/coinbase/CoinbaseStack';
import {RootStackParamList, RootStacks} from '../../Root';
import {TabsScreens} from '../../navigation/tabs/TabsStack';
import {SettingsScreens} from '../../navigation/tabs/settings/SettingsStack';
import {incomingData} from '../../store/scan/scan.effects';
import {showBlur} from '../../store/app/app.actions';
import {incomingLink} from '../../store/app/app.effects';
import useAppDispatch from './useAppDispatch';
import {useLogger} from './useLogger';
import {useMount} from './useMount';

const isUniversalLink = (url: string): boolean => {
  try {
    const domain = url.split('https://')[1].split('/')[0];
    return APP_UNIVERSAL_LINK_DOMAINS.includes(domain);
  } catch {
    return false;
  }
};

const isDeepLink = (url: string): boolean =>
  url.startsWith(APP_DEEPLINK_PREFIX) ||
  url.startsWith(APP_DEEPLINK_PREFIX.replace('//', ''));

const isCryptoLink = (url: string): boolean => {
  try {
    const prefix = url.split(':')[0];
    return APP_CRYPTO_PREFIX.includes(prefix);
  } catch {
    return false;
  }
};

export const useUrlEventHandler = () => {
  const dispatch = useAppDispatch();
  const logger = useLogger();

  const urlEventHandler = ({url}: {url: string | null}) => {
    logger.debug(`[deeplink] received: ${url}`);

    if (url && (isDeepLink(url) || isUniversalLink(url) || isCryptoLink(url))) {
      logger.info(`[deeplink] valid: ${url}`);
      dispatch(showBlur(false));

      let handled = false;

      if (!handled) {
        handled = dispatch(incomingLink(url));
      }

      if (!handled) {
        dispatch(incomingData(url));
      }

      try {
        // clicking a deeplink from the IAB in iOS doesn't auto-close the IAB, so do it manually
        InAppBrowser.isAvailable().then(isAvailable => {
          if (isAvailable) {
            InAppBrowser.close();
          }
        });
      } catch (err) {
        const errStr = err instanceof Error ? err.message : JSON.stringify(err);
        logger.error('[deeplink] not available from IAB: ' + errStr);
      }

      return handled;
    }
  };
  const handlerRef = useRef(urlEventHandler);

  return handlerRef.current;
};

export const useDeeplinks = () => {
  const urlEventHandler = useUrlEventHandler();
  const logger = useLogger();

  useMount(() => {
    const subscribeLinkingEvent = Linking.addEventListener(
      'url',
      urlEventHandler,
    );

    AppsFlyer.onDeepLink(udlData => {
      const {data, deepLinkStatus, status} = udlData;

      if (status === 'failure' || deepLinkStatus === 'Error') {
        logger.info('Failed to handle Universal Deep Link.');
        return;
      }

      if (deepLinkStatus === 'NOT_FOUND') {
        logger.info('Universal Deep Link not recognized.');
        return;
      }

      if (deepLinkStatus === 'FOUND') {
        const {deep_link_value} = data;

        urlEventHandler({url: deep_link_value});
        return;
      }

      logger.info(`Unrecognized deeplink status: ${deepLinkStatus}`);
    });

    return () => subscribeLinkingEvent.remove();
  });

  const linkingOptions: LinkingOptions<RootStackParamList> = {
    prefixes: [APP_DEEPLINK_PREFIX],
    config: {
      initialRouteName: 'Tabs',
      // configuration for associating screens with paths
      screens: {
        [RootStacks.DEBUG]: {
          path: 'debug/:name',
        },
        [RootStacks.BITPAY_ID]: {
          path: 'id',
          screens: {
            [BitpayIdScreens.PAIRING]: 'pair',
            [BitpayIdScreens.RECEIVE_SETTINGS]: 'receive-settings',
          },
        },
        [RootStacks.TABS]: {
          screens: {
            [TabsScreens.CARD]: {
              path: 'wallet-card',
              initialRouteName: CardScreens.HOME,
              screens: {
                [CardScreens.PAIRING]: 'pairing',
              },
            },
            [TabsScreens.SETTINGS]: {
              screens: {
                [SettingsScreens.Root]: 'connections/:redirectTo',
              },
            },
          },
        },
        [RootStacks.GIFT_CARD_DEEPLINK]: 'giftcard',
        [RootStacks.BUY_CRYPTO]: {
          screens: {
            [BuyCryptoScreens.ROOT]: {
              path: 'buy/:amount?',
            },
          },
        },
        [RootStacks.SWAP_CRYPTO]: {
          screens: {
            [SwapCryptoScreens.ROOT]: 'swap',
          },
        },
        [RootStacks.COINBASE]: {
          screens: {
            [CoinbaseScreens.ROOT]: 'coinbase',
          },
        },
      },
    },
  };

  return linkingOptions;
};

export default useDeeplinks;
