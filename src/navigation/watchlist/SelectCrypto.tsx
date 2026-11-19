import React, {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useRef,
} from 'react';
import {FlatList, Platform, SafeAreaView, View} from 'react-native';
import {SafeAreaView as ContextSafeAreaView} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../contexts';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {HeaderTitle, BaseText, H4} from '../../components/styled/Text';
import {HEIGHT} from '../../components/styled/Containers';
import SearchComponent from '../../components/chain-search/ChainSearch';
import {CurrencyImage} from '../../components/currency-image/CurrencyImage';
import {TouchableOpacity} from '../../components/base/TouchableOpacity';
import {
  getCoinCatalog,
  subscribeCoinCatalog,
} from '../../store/watchlist/coin-registry';
import {openPriceAlert, addCoinFromUi} from './watchlistUi.effects';
import {searchWatchlistCoins} from './coinSearch';
import {watchlistImage} from './watchlistRows';
import {Slate, Slate30, SlateDark} from '../../styles/colors';
import AngleRight from '../../../assets/img/angle-right.svg';
import Close from '../../components/modal/close/Close';
import {startGetRates} from '../../store/wallet/effects/rates/rates';
import {
  findWatchlistRow,
  watchlistCoin,
  type WatchlistSearchEntry,
} from '../../store/watchlist/coins';

const EMPTY: [] = [];
const ignoreResults = () => {};
// Match GlobalSelect's UIKit safe-area handling inside an iOS modal.
const ModalSafeArea =
  Platform.OS === 'ios' ? SafeAreaView : ContextSafeAreaView;
export default function SelectCrypto() {
  const {t} = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation<any>();
  const dispatch = useAppDispatch();
  const catalog = useSyncExternalStore(subscribeCoinCatalog, getCoinCatalog);
  const items = useAppSelector(state => state.WATCHLIST.items);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(50);
  const picked = useRef(false);
  const results = useMemo(
    () => searchWatchlistCoins(catalog, items, query, limit),
    [catalog, items, query, limit],
  );
  useLayoutEffect(() => {
    navigation.setOptions({headerShown: false});
  }, [navigation]);
  const pick = (entry: WatchlistSearchEntry) => {
    const coin = watchlistCoin(entry);
    if (picked.current || findWatchlistRow(catalog, items, coin.selector)) {
      return;
    }
    if (!dispatch(addCoinFromUi(coin, 'GlobalSelect'))) {
      return;
    }
    picked.current = true;
    navigation.goBack();
    // Native-stack can remove the outgoing route before transitionEnd reaches
    // its listeners. The post-dismiss delay must survive that unmount.
    setTimeout(() => dispatch(openPriceAlert(coin, 'Watchlist', true)), 700);
    void dispatch(startGetRates({force: true}));
  };
  return (
    <ModalSafeArea style={{flex: 1, backgroundColor: theme.colors.background}}>
      <View
        style={{height: 50, marginHorizontal: 10, justifyContent: 'center'}}>
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            alignItems: 'center',
          }}>
          <HeaderTitle
            style={{fontSize: 18, lineHeight: 24, fontWeight: '700'}}>
            {t('Select Crypto')}
          </HeaderTitle>
        </View>
        <TouchableOpacity
          touchableLibrary="react-native"
          accessibilityRole="button"
          accessibilityLabel={t('Close')}
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onPress={() => navigation.goBack()}>
          <View
            style={{
              width: 41,
              height: 41,
              borderRadius: 50,
              backgroundColor: `${Slate}33`,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
            <Close />
          </View>
        </TouchableOpacity>
      </View>
      <View style={{flex: 1, paddingHorizontal: 12}}>
        <View style={{marginBottom: 16, marginTop: 12}}>
          <SearchComponent
            context="buy"
            hideFilter
            autoCorrect={false}
            autoCapitalize="none"
            searchVal={query}
            setSearchVal={value => {
              setQuery(value);
              setLimit(50);
            }}
            searchFullList={EMPTY}
            searchResults={EMPTY}
            setSearchResults={ignoreResults}
          />
        </View>
        <FlatList
          data={results}
          ListEmptyComponent={
            query.trim() ? (
              <View
                style={{
                  alignItems: 'center',
                  minHeight: HEIGHT - 300,
                  paddingTop: 20,
                }}>
                <H4 style={{fontSize: 17}}>{t('No Results')}</H4>
              </View>
            ) : null
          }
          keyExtractor={coin => coin.displayKey}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{paddingBottom: 150}}
          onEndReached={() => {
            if (query && results.length === limit) {
              setLimit(value => value + 50);
            }
          }}
          onEndReachedThreshold={0.5}
          renderItem={({item}) => {
            const watched = !!findWatchlistRow(catalog, items, item.selector);
            return (
              <TouchableOpacity
                accessible
                accessibilityRole="button"
                accessibilityState={{disabled: watched}}
                accessibilityLabel={
                  watched
                    ? t('{{name}} {{symbol}}, on watchlist, dimmed', {
                        name: item.name,
                        symbol: item.symbol,
                      })
                    : `${item.name} ${item.symbol}`
                }
                onPress={() => {
                  if (!watched) {
                    pick(item);
                  }
                }}
                style={{
                  opacity: watched ? 0.5 : 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: 10,
                  paddingHorizontal: 4,
                  marginHorizontal: 6,
                }}>
                <View
                  style={{
                    width: 50,
                    height: 50,
                    justifyContent: 'center',
                    marginRight: 3,
                  }}>
                  <CurrencyImage img={watchlistImage(item)} size={40} />
                </View>
                <View style={{flex: 1, marginLeft: 8}}>
                  <BaseText
                    style={{fontSize: 18, lineHeight: 24, fontWeight: '500'}}>
                    {item.name}
                  </BaseText>
                  <BaseText
                    style={{
                      fontSize: 14,
                      lineHeight: 18,
                      marginTop: 6,
                      color: theme.dark ? Slate30 : SlateDark,
                    }}>
                    {item.symbol.toUpperCase()}
                  </BaseText>
                </View>
                {watched ? (
                  <View
                    style={{
                      borderWidth: 1,
                      borderColor: Slate30,
                      borderRadius: 2.4,
                      paddingHorizontal: 4,
                      marginRight: 4,
                    }}>
                    <BaseText style={{fontSize: 10}}>
                      {t('On Watchlist')}
                    </BaseText>
                  </View>
                ) : (
                  <AngleRight />
                )}
              </TouchableOpacity>
            );
          }}
        />
      </View>
    </ModalSafeArea>
  );
}
