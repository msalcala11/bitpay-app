import React, {
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useRef,
} from 'react';
import {FlatList, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useTheme} from '../../contexts';
import {useAppDispatch, useAppSelector} from '../../utils/hooks';
import {useStackScreenOptions} from '../utils/headerHelpers';
import {HeaderTitle, BaseText} from '../../components/styled/Text';
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
import {Slate30, SlateDark} from '../../styles/colors';
import AngleRight from '../../../assets/img/angle-right.svg';
import Close from '../../../assets/img/close-modal-icon.svg';
import {startGetRates} from '../../store/wallet/effects/rates/rates';
import type {WatchlistCoin} from '../../store/watchlist/watchlist.models';

const EMPTY: [] = [];
const ignoreResults = () => {};
export default function SelectCrypto() {
  const {t} = useTranslation();
  const theme = useTheme();
  const navigation = useNavigation<any>();
  const dispatch = useAppDispatch();
  const options = useStackScreenOptions(theme);
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
    navigation.setOptions({
      ...options,
      headerTitle: () => <HeaderTitle>{t('Select Crypto')}</HeaderTitle>,
      headerLeft: () => (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t('Close')}
          style={{
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onPress={() => navigation.goBack()}>
          <Close />
        </TouchableOpacity>
      ),
    });
  }, [navigation, options, t]);
  const pick = (coin: WatchlistCoin) => {
    if (picked.current || items.some(item => item.id === coin.id)) {
      return;
    }
    if (!dispatch(addCoinFromUi(coin, 'GlobalSelect'))) {
      return;
    }
    picked.current = true;
    const unsubscribe = navigation.addListener(
      'transitionEnd',
      (event: {data: {closing: boolean}}) => {
        if (event.data.closing) {
          unsubscribe();
          setTimeout(
            () => dispatch(openPriceAlert(coin, 'Watchlist', true)),
            700,
          );
        }
      },
    );
    navigation.goBack();
    void dispatch(startGetRates({force: true}));
  };
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingHorizontal: 12,
      }}>
      <View style={{marginBottom: 16, marginTop: 12}}>
        <SearchComponent
          context="buy"
          hideFilter
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
        keyExtractor={coin => coin.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingBottom: 150}}
        onEndReached={() => {
          if (query && results.length === limit) {
            setLimit(value => value + 50);
          }
        }}
        onEndReachedThreshold={0.5}
        renderItem={({item}) => {
          const watched = items.some(coin => coin.id === item.id);
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
  );
}
