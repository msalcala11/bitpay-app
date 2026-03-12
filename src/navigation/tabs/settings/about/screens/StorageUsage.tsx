import React, {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {InteractionManager, Platform} from 'react-native';
import RNFS from 'react-native-fs';
import SkeletonPlaceholder from 'react-native-skeleton-placeholder';
import {useNavigation} from '@react-navigation/native';
import styled, {useTheme} from 'styled-components/native';
import {forEach} from 'lodash';
import {SettingsComponent, SettingsContainer} from '../../SettingsRoot';
import {
  Hr,
  ScreenGutter,
  Setting,
  SettingTitle,
} from '../../../../../components/styled/Containers';
import Button from '../../../../../components/button/Button';
import {
  Action,
  Black,
  Feather,
  LightBlack,
  LightBlue,
  Midnight,
  White,
} from '../../../../../styles/colors';
import {useAppSelector} from '../../../../../utils/hooks';
import {storage} from '../../../../../store';
import {logManager} from '../../../../../managers/LogManager';
import {AboutScreens} from '../AboutGroup';

const ScrollContainer = styled.ScrollView``;

const ValueSkeleton = ({width = 90}: {width?: number}) => {
  const theme = useTheme();
  const backgroundColor = theme.dark ? Midnight : LightBlue;
  const highlightColor = theme.dark ? Action : '#E5E9FF';
  return (
    <SkeletonPlaceholder
      backgroundColor={backgroundColor}
      highlightColor={highlightColor}>
      <SkeletonPlaceholder.Item width={width} height={36} borderRadius={999} />
    </SkeletonPlaceholder>
  );
};

const HeaderTitle = styled(Setting)`
  margin-top: 20px;
  background-color: ${({theme: {dark}}) => (dark ? LightBlack : Feather)};
  padding: 0 ${ScreenGutter};
  border-bottom-width: 1px;
  border-bottom-color: ${({theme: {dark}}) => (dark ? Black : White)};
`;

const storagePath =
  Platform.OS === 'ios' ? RNFS.MainBundlePath : RNFS.DocumentDirectoryPath;

type PersistRootSlices = Record<string, unknown>;

const getUtf8ByteLength = (value: string): number => {
  const TextEncoderCtor = (globalThis as any)?.TextEncoder;
  if (typeof TextEncoderCtor === 'function') {
    return new TextEncoderCtor().encode(value).length;
  }

  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);

    if (code < 0x80) {
      bytes += 1;
      continue;
    }

    if (code < 0x800) {
      bytes += 2;
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const nextCode = value.charCodeAt(i + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        bytes += 4;
        i += 1;
        continue;
      }
    }

    bytes += 3;
  }

  return bytes;
};

const getSerializedByteSize = (value: unknown): number => {
  try {
    if (typeof value === 'string') {
      return getUtf8ByteLength(value);
    }

    const serialized = JSON.stringify(value);
    return serialized ? getUtf8ByteLength(serialized) : 0;
  } catch {
    return 0;
  }
};

const readPersistRootSlices = (): PersistRootSlices => {
  const root = storage.getString('persist:root');
  if (!root) {
    return {};
  }

  try {
    const parsed = JSON.parse(root);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const getPersistedSlicesByteSize = (
  persistRoot: PersistRootSlices,
  sliceKeys: string[],
): number => {
  return sliceKeys.reduce(
    (total, sliceKey) => total + getSerializedByteSize(persistRoot?.[sliceKey]),
    0,
  );
};

const StorageUsage: React.FC = () => {

  const navigation = useNavigation();
  const {t} = useTranslation();
  const renderValue = useCallback((value: string, width?: number) => {
    if (value) {
      return <Button buttonType="pill">{value}</Button>;
    }
    return <ValueSkeleton width={width} />;
  }, []);
  const tripleTapRef = useRef<{
    count: number;
    lastTapMs: number;
    timer?: ReturnType<typeof setTimeout>;
  }>({count: 0, lastTapMs: 0});

  const runAfterTripleTap = useCallback((action: () => void) => {
    const now = Date.now();
    const windowMs = 600;
    const state = tripleTapRef.current;

    if (now - state.lastTapMs > windowMs) {
      state.count = 1;
    } else {
      state.count += 1;
    }

    state.lastTapMs = now;

    if (state.timer) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      if (state.count >= 3) {
        action();
      }
      state.count = 0;
      state.lastTapMs = 0;
    }, windowMs);
  }, []);

  const handlePortfolioPress = useCallback(() => {
    runAfterTripleTap(() =>
      navigation.navigate(AboutScreens.PORTFOLIO_DEBUG as never),
    );
  }, [navigation, runAfterTripleTap]);

  const [walletsCount, setWalletsCount] = useState<number>(0);
  const [giftCount, setGiftCount] = useState<number>(0);
  const [contactCount, setContactCount] = useState<number>(0);
  const [customTokenCount, setCustomTokenCount] = useState<number>(0);

  const [appSize, setAppSize] = useState<string>('');
  const [deviceFreeStorage, setDeviceFreeStorage] = useState<string>('');
  const [deviceTotalStorage, setDeviceTotalStorage] = useState<string>('');
  const [giftCardStorage, setGiftCardStorage] = useState<string>('');
  const [walletStorage, setWalletStorage] = useState<string>('');
  const [customTokenStorage, setCustomTokenStorage] = useState<string>('');
  const [contactStorage, setContactStorage] = useState<string>('');
  const [ratesStorage, setRatesStorage] = useState<string>('');
  const [portfolioPersistedStorage, setPortfolioPersistedStorage] =
    useState<string>('');
  const [backupStorage, setBackupStorage] = useState<string>('');
  const [shopCatalogStorage, setShopCatalogStorage] = useState<string>('');

  const giftCards = useAppSelector(
    ({APP, SHOP}) => SHOP.giftCards[APP.network],
  );
  const keys = useAppSelector(({WALLET}) => WALLET.keys);
  const customTokens = useAppSelector(({WALLET}) => WALLET.customTokenData);
  const contacts = useAppSelector(({CONTACT}) => CONTACT.list);
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const fiatRateSeriesCache = useAppSelector(
    ({RATE}) => RATE.fiatRateSeriesCache,
  );

  const portfolio = useAppSelector(({PORTFOLIO}) => PORTFOLIO);

  const portfolioSnapshotsCount = useAppSelector(({PORTFOLIO}) => {
    let total = 0;
    const byWalletId = PORTFOLIO.snapshotsByWalletId || {};
    Object.values(byWalletId).forEach(v => {
      total += Array.isArray(v) ? v.length : 0;
    });
    return total;
  });

  const formatBytes = (bytes: number, decimals = 2): string => {
    if (!+bytes) {
      return '0 Bytes';
    }

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  };

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const interaction = InteractionManager.runAfterInteractions(() => {
      const persistRoot = readPersistRootSlices();

      const setFormattedSerializedStorage = (
        value: unknown,
        setter: (nextValue: string) => void,
      ) => {
        setter(formatBytes(getSerializedByteSize(value)));
      };

      const _setAppSize = async () => {
        try {
          const resultStorage = await RNFS.readDir(storagePath);
          let totalAppSize = 0;
          forEach(resultStorage, data => {
            totalAppSize += data.size;
          });
          setAppSize(formatBytes(totalAppSize));
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setAppSize] Error ', errStr);
        }
      };

      const _setShopCatalogStorage = async () => {
        try {
          const bytes = getPersistedSlicesByteSize(persistRoot, ['SHOP_CATALOG']);
          setShopCatalogStorage(formatBytes(bytes));
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setShopCatalogStorage] Error ', errStr);
        }
      };

      const _setBackupStorage = async () => {
        try {
          const baseDir = RNFS.CachesDirectoryPath + '/bitpay/redux';
          const finalFile = baseDir + '/persist-root.json';
          const bakFile = finalFile + '.bak';
          let bytes = 0;
          const finalExists = await RNFS.exists(finalFile);
          if (finalExists) {
            const stat = await RNFS.stat(finalFile);
            bytes = Number(stat.size) || 0;
          } else {
            const bakExists = await RNFS.exists(bakFile);
            if (bakExists) {
              const stat = await RNFS.stat(bakFile);
              bytes = Number(stat.size) || 0;
            }
          }
          setBackupStorage(formatBytes(bytes));
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setBackupStorage] Error ', errStr);
        }
      };

      const _setDeviceStorage = async () => {
        try {
          const resultDeviceStorage = await RNFS.getFSInfo();
          if (resultDeviceStorage) {
            setDeviceFreeStorage(formatBytes(resultDeviceStorage.freeSpace));
            setDeviceTotalStorage(formatBytes(resultDeviceStorage.totalSpace));
          }
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setDeviceStorage] Error ', errStr);
        }
      };

      const _setDataCounterStorage = async () => {
        try {
          const walletCounts = Object.values(keys).map(keyItem => {
            const {wallets: keyWallets} = keyItem as {wallets: Array<unknown>};
            return keyWallets.length;
          });
          const totalWalletsCount = walletCounts.reduce((a, b) => a + b, 0);
          setWalletsCount(totalWalletsCount);
          setGiftCount(giftCards.length);
          setContactCount(contacts.length);
          setCustomTokenCount(Object.values(customTokens).length);
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setDataCounterStorage] Error ', errStr);
        }
      };

      const _setWalletStorage = async () => {
        try {
          setFormattedSerializedStorage(keys, setWalletStorage);
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setWalletStorage] Error ', errStr);
        }
      };

      const _setGiftCardStorage = async () => {
        try {
          setFormattedSerializedStorage(giftCards, setGiftCardStorage);
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setGiftCardStorage] Error ', errStr);
        }
      };

      const _setCustomTokensStorage = async () => {
        try {
          setFormattedSerializedStorage(customTokens, setCustomTokenStorage);
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setCustomTokensStorage] Error ', errStr);
        }
      };

      const _setContactStorage = async () => {
        try {
          setFormattedSerializedStorage(contacts, setContactStorage);
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setContactStorage] Error ', errStr);
        }
      };

      const _setRatesStorage = async () => {
        try {
          setFormattedSerializedStorage(
            {rates, fiatRateSeriesCache},
            setRatesStorage,
          );
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setRatesStorage] Error ', errStr);
        }
      };

      const _setPortfolioStorage = async () => {
        try {
          const bytes = getPersistedSlicesByteSize(persistRoot, [
            'PORTFOLIO',
            'PORTFOLIO_CHARTS',
          ]);
          setPortfolioPersistedStorage(formatBytes(bytes));
        } catch (err) {
          const errStr =
            err instanceof Error ? err.message : JSON.stringify(err);
          logManager.error('[setPortfolioStorage] Error ', errStr);
        }
      };

      const tasks = [
        _setAppSize,
        _setDeviceStorage,
        _setDataCounterStorage,
        _setWalletStorage,
        _setGiftCardStorage,
        _setCustomTokensStorage,
        _setContactStorage,
        _setRatesStorage,
        _setPortfolioStorage,
        _setBackupStorage,
        _setShopCatalogStorage,
      ];

      timeout = setTimeout(() => {
        tasks.forEach(task => task());
      }, 250);
    });

    return () => {
      interaction?.cancel?.();
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [
    contacts,
    customTokens,
    fiatRateSeriesCache,
    giftCards,
    keys,
    portfolio,
    rates,
  ]);

  useEffect(() => {
    const tripleTapState = tripleTapRef.current;
    return () => {
      const timer = tripleTapState.timer;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <SettingsContainer>
      <ScrollContainer>
        <HeaderTitle>
          <SettingTitle>{t('Total Size')}</SettingTitle>
        </HeaderTitle>
        <SettingsComponent>
          <Setting>
            <SettingTitle>BitPay</SettingTitle>

            {renderValue(appSize, 110)}
          </Setting>

          <Hr />

          <Setting>
            <SettingTitle>{t('Free Disk Storage')}</SettingTitle>

            {renderValue(deviceFreeStorage, 110)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>{t('Total Disk Storage')}</SettingTitle>

            {renderValue(deviceTotalStorage, 110)}
          </Setting>
        </SettingsComponent>
        <HeaderTitle>
          <SettingTitle>{t('Details')}</SettingTitle>
        </HeaderTitle>
        <SettingsComponent style={{marginBottom: 10}}>
          <Setting>
            <SettingTitle>
              {t('Wallets')} ({walletsCount || '0'})
            </SettingTitle>

            {renderValue(walletStorage)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>
              {t('Gift Cards')} ({giftCount || '0'})
            </SettingTitle>

            {renderValue(giftCardStorage)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>
              {t('Custom Tokens')} ({customTokenCount || '0'})
            </SettingTitle>

            {renderValue(customTokenStorage)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>
              {t('Contacts')} ({contactCount || '0'})
            </SettingTitle>

            {renderValue(contactStorage)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>{t('Rates')}</SettingTitle>

            {renderValue(ratesStorage)}
          </Setting>

          <Hr />
          <Setting onPress={handlePortfolioPress}>
            <SettingTitle>
              {t('Portfolio')} ({portfolioSnapshotsCount || '0'})
            </SettingTitle>

            {renderValue(portfolioPersistedStorage)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>{t('Shop Catalog')}</SettingTitle>

            {renderValue(shopCatalogStorage)}
          </Setting>

          <Hr />
          <Setting>
            <SettingTitle>{t('Filesystem Backup')}</SettingTitle>

            {renderValue(backupStorage)}
          </Setting>
        </SettingsComponent>
      </ScrollContainer>
    </SettingsContainer>
  );
};

export default StorageUsage;
