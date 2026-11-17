import React from 'react';
import {View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import HomeSection from '../tabs/home/components/HomeSection';
import ChevronRightSvg from '../tabs/home/components/ChevronRightSvg';
import {BaseText} from '../../components/styled/Text';
import Button from '../../components/button/Button';
import {TouchableOpacity} from '../../components/base/TouchableOpacity';
import {useAppSelector} from '../../utils/hooks';
import {WatchlistRow} from './WatchlistRow';
import type {ExchangeRateItemProps} from '../tabs/home/components/exchange-rates/ExchangeRateItem';

export const WatchlistHomeSection = ({
  rows,
}: {
  rows: ExchangeRateItemProps[];
}) => {
  const {t} = useTranslation();
  const navigation = useNavigation<any>();
  const items = useAppSelector(state => state.WATCHLIST.items);
  return (
    <View>
      <HomeSection title={t('Watchlist')} label={t('24H')}>
        {items.length ? (
          <View style={{marginTop: 6}}>
            {items.slice(0, 5).map(coin => {
              const row = rows.find(value => value.id === coin.id);
              return row ? (
                <WatchlistRow
                  key={coin.id}
                  coin={coin}
                  row={row}
                  context="HomeRoot"
                />
              ) : null;
            })}
          </View>
        ) : (
          <View style={{margin: 16, gap: 12}}>
            <BaseText>{t('Add crypto to keep an eye on prices.')}</BaseText>
            <Button
              height={50}
              buttonStyle="secondary"
              buttonOutline
              onPress={() => navigation.navigate('WatchlistSelectCrypto')}>
              {t('Add Crypto')}
            </Button>
          </View>
        )}
      </HomeSection>
      {items.length ? (
        <TouchableOpacity
          style={{
            position: 'absolute',
            top: -6,
            right: 6,
            width: 44,
            height: 44,
            justifyContent: 'center',
            alignItems: 'center',
          }}
          accessibilityRole="button"
          accessibilityLabel={t('See all watchlist')}
          onPress={() => navigation.navigate('Watchlist')}>
          <ChevronRightSvg width={13} height={19} gray />
        </TouchableOpacity>
      ) : null}
    </View>
  );
};
