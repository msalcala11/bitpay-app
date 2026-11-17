import React, {
  useCallback,
  useLayoutEffect,
  useState,
  useEffect,
  useRef,
} from 'react';
import {View, FlatList} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import ReorderableList from 'react-native-reorderable-list';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../contexts';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {useStackScreenOptions} from '../utils/headerHelpers';
import {HeaderTitle, H5} from '../../components/styled/Text';
import Button from '../../components/button/Button';
import AddSvg from '../tabs/home/components/AddSvg';
import CustomizeSvg from '../tabs/home/components/CustomizeSvg';
import {TouchableOpacity} from '../../components/base/TouchableOpacity';
import Ghost from '../../../assets/img/wallet/ghost-straight-face.svg';
import {
  reorderWatchlist,
  syncPriceAlerts,
} from '../../store/watchlist/watchlist.effects';
import {useWatchlistRows} from './useWatchlistRows';
import {canAddWatchlistCoin} from './watchlistUi.effects';
import {EditableWatchlistRow, WatchlistRow} from './WatchlistRow';

export const WatchlistEmpty = () => {
  const {t} = useTranslation();
  return (
    <View style={{alignItems: 'center', marginTop: 50, gap: 20}}>
      <H5>{t("It's a ghost town in here")}</H5>
      <Ghost />
    </View>
  );
};
export default function WatchlistScreen() {
  const {t} = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation<any>();
  const dispatch = useAppDispatch();
  const options = useStackScreenOptions(theme);
  const [edit, setEdit] = useState(false);
  const items = useAppSelector(state => state.WATCHLIST.items);
  const rows = useWatchlistRows();
  const listRef = useRef<FlatList>(null);
  const lastAdded = useAppSelector(state => state.WATCHLIST.lastAdded);
  const [highlighted, setHighlighted] = useState<string>();
  useEffect(() => {
    if (!lastAdded) {
      return;
    }
    setHighlighted(lastAdded.id);
    const scroll = setTimeout(
      () => listRef.current?.scrollToEnd({animated: true}),
      100,
    );
    const clear = setTimeout(() => setHighlighted(undefined), 1500);
    return () => {
      clearTimeout(scroll);
      clearTimeout(clear);
    };
  }, [lastAdded]);
  useFocusEffect(
    useCallback(() => {
      void dispatch(syncPriceAlerts());
    }, [dispatch]),
  );
  useLayoutEffect(() => {
    navigation.setOptions({
      ...options,
      headerTitle: () => <HeaderTitle>{t('Watchlist')}</HeaderTitle>,
      headerRight: () =>
        edit ? (
          <Button buttonType="pill" onPress={() => setEdit(false)}>
            {t('Done')}
          </Button>
        ) : (
          <View style={{flexDirection: 'row', gap: 4}}>
            <TouchableOpacity
              style={{width: 44, height: 44}}
              accessibilityRole="button"
              accessibilityLabel={t('Add crypto')}
              onPress={() => {
                if (dispatch(canAddWatchlistCoin())) {
                  navigation.navigate('WatchlistSelectCrypto');
                }
              }}>
              <AddSvg width={40} height={40} />
            </TouchableOpacity>
            {items.length ? (
              <TouchableOpacity
                style={{width: 44, height: 44}}
                accessibilityRole="button"
                accessibilityLabel={t('Edit watchlist')}
                onPress={() => setEdit(true)}>
                <CustomizeSvg width={40} height={40} />
              </TouchableOpacity>
            ) : null}
          </View>
        ),
    });
  }, [dispatch, edit, items.length, navigation, options, t]);
  const renderItem = ({
    item,
    index,
  }: {
    item: (typeof items)[number];
    index: number;
  }) =>
    edit ? (
      <EditableWatchlistRow coin={item} row={rows[index]} />
    ) : (
      <WatchlistRow
        coin={item}
        row={rows[index]}
        highlighted={highlighted === item.id}
      />
    );
  return (
    <View style={{flex: 1, backgroundColor: theme.colors.background}}>
      {edit ? (
        <ReorderableList
          data={items}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          onReorder={({from, to}) =>
            dispatch(reorderWatchlist(items[from].id, to))
          }
          contentContainerStyle={{paddingTop: 6, paddingBottom: 40}}
        />
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={{paddingTop: 6, paddingBottom: 40}}
          ListEmptyComponent={WatchlistEmpty}
        />
      )}
    </View>
  );
}
