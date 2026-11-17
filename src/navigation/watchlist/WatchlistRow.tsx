import React from 'react';
import {View, StyleSheet} from 'react-native';
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import {useReorderableDrag} from 'react-native-reorderable-list';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../contexts';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import ExchangeRateItem, {
  ExchangeRateItemProps,
} from '../tabs/home/components/exchange-rates/ExchangeRateItem';
import {BaseText} from '../../components/styled/Text';
import {TouchableOpacity} from '../../components/base/TouchableOpacity';
import Remove from '../../../assets/img/remove.svg';
import Bell from '../../../assets/img/notification-filled.svg';
import Hamburger from '../../../assets/img/hamburger.svg';
import {
  Caution25,
  Slate30,
  SlateDark,
  LuckySevens,
  LightBlue,
  Midnight,
} from '../../styles/colors';
import {
  removeWatchlistCoin,
  reorderWatchlist,
} from '../../store/watchlist/watchlist.effects';
import {
  selectAlertContext,
  selectAlertsAvailable,
} from '../../store/watchlist/watchlist.selectors';
import type {WatchlistCoin} from '../../store/watchlist/watchlist.models';

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16},
  content: {flex: 1},
  touch: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swipe: {
    width: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Caution25,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 2.4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
});

export const AlertBadge = ({threshold}: {threshold: number}) => {
  const theme = useTheme();
  const {t} = useTranslation();
  const color = theme.dark ? Slate30 : SlateDark;
  return (
    <View
      accessible
      accessibilityLabel={t('Price alert at {{threshold}}%', {threshold})}
      style={[styles.badge, {borderColor: theme.dark ? LuckySevens : Slate30}]}>
      <Bell width={10} height={10} color={color} />
      <BaseText
        style={{
          fontSize: 10,
          lineHeight: 13,
          color,
        }}>{`±${threshold}%`}</BaseText>
    </View>
  );
};

export const WatchlistRow = ({
  coin,
  row,
  edit = false,
  highlighted = false,
  context: _context = 'Watchlist',
  onDrag,
}: {
  coin: WatchlistCoin;
  row: ExchangeRateItemProps;
  edit?: boolean;
  highlighted?: boolean;
  context?: 'HomeRoot' | 'Watchlist';
  onDrag?: () => void;
}) => {
  const dispatch = useAppDispatch();
  const navigation = useNavigation<any>();
  const theme = useTheme();
  const {t} = useTranslation();
  const threshold = useAppSelector(
    state => selectAlertContext(state)?.alerts[coin.id]?.alert.thresholdPct,
  );
  const available = useAppSelector(selectAlertsAvailable);
  const index = useAppSelector(state =>
    state.WATCHLIST.items.findIndex(item => item.id === coin.id),
  );
  const remove = () => dispatch(removeWatchlistCoin(coin));
  const open = () => {
    if (!edit) {
      navigation.navigate('ExchangeRate', {
        currencyName: coin.name,
        currencyAbbreviation: row.currencyAbbreviation,
        chain: row.chain,
        tokenAddress: row.tokenAddress,
      });
    }
  };
  const code = useAppSelector(state => state.APP.defaultAltCurrency.isoCode);
  const content = (
    <View
      style={[
        styles.row,
        {
          backgroundColor: highlighted
            ? theme.dark
              ? Midnight
              : LightBlue
            : theme.colors.background,
        },
      ]}>
      {edit ? (
        <TouchableOpacity
          style={styles.touch}
          accessibilityRole="button"
          accessibilityLabel={t('Remove {{coin}}', {coin: coin.name})}
          onPress={remove}>
          <Remove width={24} height={24} />
        </TouchableOpacity>
      ) : null}
      <View style={styles.content}>
        <ExchangeRateItem
          item={row}
          defaultAltCurrencyIsoCode={code}
          onPress={open}
          badge={
            !edit && available && threshold ? (
              <AlertBadge threshold={threshold} />
            ) : undefined
          }
          accessibilityLabel={
            threshold && available
              ? t('{{coin}} exchange rate, price alert at {{threshold}}%', {
                  coin: coin.name,
                  threshold,
                })
              : t('{{coin}} exchange rate', {coin: coin.name})
          }
          accessibilityActions={[
            {name: 'remove', label: t('Remove')},
            ...(edit
              ? [
                  {name: 'up', label: t('Move up')},
                  {name: 'down', label: t('Move down')},
                  {name: 'top', label: t('Move to top')},
                ]
              : []),
          ]}
          onAccessibilityAction={({nativeEvent}) => {
            if (nativeEvent.actionName === 'remove') {
              remove();
            } else {
              dispatch(
                reorderWatchlist(
                  coin.id,
                  nativeEvent.actionName === 'up'
                    ? index - 1
                    : nativeEvent.actionName === 'down'
                    ? index + 1
                    : 0,
                ),
              );
            }
          }}
        />
      </View>
      {edit ? (
        <TouchableOpacity
          style={styles.touch}
          accessibilityRole="button"
          accessibilityLabel={t('Reorder {{coin}}', {coin: coin.name})}
          onLongPress={onDrag}
          delayLongPress={100}>
          <Hamburger />
        </TouchableOpacity>
      ) : null}
    </View>
  );
  return edit ? (
    content
  ) : (
    <Swipeable
      renderRightActions={() => (
        <TouchableOpacity
          style={styles.swipe}
          accessible={false}
          onPress={remove}>
          <Remove width={24} height={24} />
        </TouchableOpacity>
      )}
      overshootRight={false}>
      {content}
    </Swipeable>
  );
};
export const EditableWatchlistRow = (
  props: React.ComponentProps<typeof WatchlistRow>,
) => {
  const drag = useReorderableDrag();
  return <WatchlistRow {...props} edit onDrag={drag} />;
};
