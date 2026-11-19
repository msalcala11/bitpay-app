import React, {useSyncExternalStore} from 'react';
import {View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../contexts';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {TouchableOpacity} from '../../components/base/TouchableOpacity';
import Star from '../../../assets/img/star.svg';
import StarOutline from '../../../assets/img/star-outline.svg';
import Bell from '../../../assets/img/notification-filled.svg';
import BellOutline from '../../../assets/img/notification.svg';
import {
  Action,
  LinkBlue,
  Slate,
  SlateDark,
  LightBlack,
  NeutralSlate,
} from '../../styles/colors';
import {
  getCoinCatalog,
  subscribeCoinCatalog,
} from '../../store/watchlist/coin-registry';
import type {WatchlistAsset} from '../../store/watchlist/watchlist.models';
import {
  selectAlertContext,
  selectAlertsAvailable,
} from '../../store/watchlist/watchlist.selectors';
import {
  addCoinFromUi,
  confirmRemoveWatchlistCoin,
  openPriceAlert,
} from './watchlistUi.effects';
import {findWatchlistRow, watchlistCoin} from '../../store/watchlist/coins';
import type {Option} from '../wallet/components/OptionsSheet';

export const useWatchlistCoin = (asset: WatchlistAsset) => {
  const catalog = useSyncExternalStore(subscribeCoinCatalog, getCoinCatalog);
  const items = useAppSelector(state => state.WATCHLIST.items);
  const row = findWatchlistRow(catalog, items, asset);
  return {
    coin: row || catalog.match(asset),
    watching: !!row,
    asset: catalog.resolveAsset(asset),
  };
};
export const WatchlistIcon = ({
  kind,
  selected,
  size = 24,
}: {
  kind: 'star' | 'bell';
  selected: boolean;
  size?: number;
}) => {
  const theme = useTheme();
  const Icon =
    kind === 'star'
      ? selected
        ? Star
        : StarOutline
      : selected
      ? Bell
      : BellOutline;
  return (
    <Icon
      width={size}
      height={size}
      color={
        selected
          ? theme.dark
            ? LinkBlue
            : Action
          : theme.dark
          ? Slate
          : SlateDark
      }
    />
  );
};
export const WatchlistHeaderActions = ({asset}: {asset: WatchlistAsset}) => {
  const {coin, watching} = useWatchlistCoin(asset);
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();
  const alert = useAppSelector(
    state => coin && selectAlertContext(state)?.alerts[coin.id],
  );
  const available = useAppSelector(selectAlertsAvailable);
  if (!coin) return null;
  const button = (
    kind: 'star' | 'bell',
    selected: boolean,
    label: string,
    onPress: () => void,
  ) => (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{selected}}
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.dark ? LightBlack : NeutralSlate,
        }}>
        <WatchlistIcon kind={kind} selected={selected} />
      </View>
    </TouchableOpacity>
  );
  return (
    <View style={{flexDirection: 'row', gap: 4}}>
      {button(
        'star',
        watching,
        watching
          ? t('Remove {{coin}} from watchlist', {coin: coin.name})
          : t('Add {{coin}} to watchlist', {coin: coin.name}),
        () => {
          dispatch(
            watching
              ? confirmRemoveWatchlistCoin(coin, 'PriceChart')
              : addCoinFromUi(watchlistCoin(coin), 'PriceChart'),
          );
        },
      )}
      {available
        ? button(
            'bell',
            !!alert,
            alert
              ? t('Price alert on for {{coin}}', {coin: coin.name})
              : t('Set price alert for {{coin}}', {coin: coin.name}),
            () => dispatch(openPriceAlert(watchlistCoin(coin), 'PriceChart')),
          )
        : null}
    </View>
  );
};

export const useWatchlistWalletOptions = (asset: WatchlistAsset): Option[] => {
  const {coin, watching} = useWatchlistCoin(asset);
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const alert = useAppSelector(
    state => coin && selectAlertContext(state)?.alerts[coin.id],
  );
  const available = useAppSelector(selectAlertsAvailable);
  if (!coin) {
    return [];
  }
  return [
    {
      img: <WatchlistIcon kind="star" selected />,
      title: watching ? t('Remove from Watchlist') : t('Add to Watchlist'),
      description: watching
        ? t('Stop tracking this price on Home.')
        : t('Track this price on Home.'),
      onPress: () => {
        dispatch(
          watching
            ? confirmRemoveWatchlistCoin(coin, 'WalletDetails')
            : addCoinFromUi(watchlistCoin(coin), 'WalletDetails'),
        );
      },
    },
    ...(available
      ? [
          {
            img: <WatchlistIcon kind="bell" selected />,
            title: alert ? t('Edit Price Alert') : t('Set Price Alert'),
            description: t('Get notified when the price moves.'),
            onPress: () =>
              dispatch(openPriceAlert(watchlistCoin(coin), 'WalletDetails')),
          },
        ]
      : []),
  ];
};
