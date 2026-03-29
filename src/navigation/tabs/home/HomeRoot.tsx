import {useScrollToTop, useTheme} from '@react-navigation/native';
import React, {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {useTranslation} from 'react-i18next';
import {RefreshControl, ScrollView} from 'react-native';
import {STATIC_CONTENT_CARDS_ENABLED} from '../../../constants/config';
import {
  setShowKeyMigrationFailureModal,
  showBottomNotificationModal,
} from '../../../store/app/app.actions';
import {requestBrazeContentRefresh} from '../../../store/app/app.effects';
import {
  selectBrazeMarketingCarousel,
  selectBrazeShopWithCrypto,
} from '../../../store/app/app.selectors';
import {getAndDispatchUpdatedWalletBalances} from '../../../store/wallet/effects/status/statusv2';
import {
  fetchFiatRateSeriesInterval,
  refreshRatesForPortfolioPnl,
} from '../../../store/wallet/effects';
import {updatePortfolioBalance} from '../../../store/wallet/wallet.actions';
import {SlateDark, White} from '../../../styles/colors';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {BalanceUpdateError} from '../../wallet/components/ErrorMessages';
import Crypto from './components/Crypto';
import ProfileButton from './components/HeaderProfileButton';
import ScanButton from './components/HeaderScanButton';
import HomeSection from './components/HomeSection';
import HomeExchangeRatesSection from './components/HomeExchangeRatesSection';
import LinkingButtons from './components/LinkingButtons';
import MockOffers from './components/offers/MockOffers';
import OffersCarousel from './components/offers/OffersCarousel';
import MarketingCarousel from './components/MarketingCarousel';
import PortfolioBalance from './components/PortfolioBalance';
import {HeaderContainer, HeaderLeftContainer} from './components/Styled';
import KeyMigrationFailureModal from './components/KeyMigrationFailureModal';
import {ProposalBadgeContainer} from '../../../components/styled/Containers';
import {ProposalBadge} from '../../../components/styled/Text';
import {
  receiveCrypto,
  sendCrypto,
} from '../../../store/wallet/effects/send/send';
import {maybePopulatePortfolioForWallets} from '../../../store/portfolio';
import {Analytics} from '../../../store/analytics/analytics.effects';
import {withErrorFallback} from '../TabScreenErrorFallback';
import TabContainer from '../TabContainer';
import ArchaxFooter from '../../../components/archax/archax-footer';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useStore} from 'react-redux';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../../../Root';
import type {RootState} from '../../../store';
import {TabsScreens, TabsStackParamList} from '../TabsStack';
import {Network} from '../../../constants';
import SecurePasskeyBanner from './components/SecurePasskeyBanner';
import DefaultMarketingCards from './components/DefaultMarketingCards';
import AllocationSection from './components/AllocationSection';
import AssetsSection from './components/AssetsSection';
import {getPortfolioAllocationTotalFiat} from '../../../utils/portfolio/allocation';
import type {Key} from '../../../store/wallet/wallet.models';
import {
  getQuoteCurrency,
  getVisibleWalletsFromKeys,
  walletHasNonZeroLiveBalance,
} from '../../../utils/portfolio/assets';
import {sortNewestFirst} from '../../../utils/braze';
import {
  measurePerfAsync,
  measurePerfSync,
  recordPerfEvent,
} from '../../../utils/perfLogger';
import {summarizeReactPerfSnapshotChanges} from '../../../utils/reactPerf';

export type HomeScreenProps = NativeStackScreenProps<
  TabsStackParamList,
  TabsScreens.HOME
>;

const HomeRoot: React.FC<HomeScreenProps> = ({route, navigation}) => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const {currencyAbbreviation} = route.params || {};
  const theme = useTheme();
  const reduxStore = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const brazeMarketingCarousel = useAppSelector(selectBrazeMarketingCarousel);
  const brazeShopWithCrypto = useAppSelector(selectBrazeShopWithCrypto);
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);
  const wallets = (Object.values(keys) as Key[]).flatMap((k: Key) => k.wallets);
  const pendingTxps = wallets.flatMap(w => w.pendingTxps);
  const appIsLoading = useAppSelector(({APP}) => APP.appIsLoading);
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const keyMigrationFailure = useAppSelector(
    ({APP}) => APP.keyMigrationFailure,
  );
  const keyMigrationFailureModalHasBeenShown = useAppSelector(
    ({APP}) => APP.keyMigrationFailureModalHasBeenShown,
  );
  const showPortfolioValue = useAppSelector(({APP}) => APP.showPortfolioValue);
  const hasKeys = Object.values(keys).length;

  const portfolioAllocationTotalFiat = useMemo(() => {
    return measurePerfSync(
      'screen.home_root.portfolio_allocation_total_fiat',
      () =>
        getPortfolioAllocationTotalFiat({
          keys,
          homeCarouselConfig,
        }),
      {
        keyCount: Object.keys(keys || {}).length,
        screen: 'HomeRoot',
      },
    );
  }, [homeCarouselConfig, keys]);

  const hasAnyVisibleWalletBalance = useMemo(() => {
    return measurePerfSync(
      'screen.home_root.has_any_visible_wallet_balance',
      () => {
        const visibleWallets = getVisibleWalletsFromKeys(
          keys,
          homeCarouselConfig,
        );

        return visibleWallets.some(walletHasNonZeroLiveBalance);
      },
      {
        keyCount: Object.keys(keys || {}).length,
        screen: 'HomeRoot',
      },
    );
  }, [homeCarouselConfig, keys]);

  const showPortfolioAllocationSection =
    portfolioAllocationTotalFiat > 0 || hasAnyVisibleWalletBalance;

  const showArchaxBanner = useAppSelector(({APP}) => APP.showArchaxBanner);
  const network: Network = useAppSelector(({APP}) => APP.network);
  const user = useAppSelector(({BITPAY_ID}) => BITPAY_ID.user[network]);
  const passkeyCredentials = useAppSelector(
    ({BITPAY_ID}) => BITPAY_ID.passkeyCredentials,
  );
  const [showSecureAccountBanner, setShowSecureAccountBanner] = useState(false);
  const lastChartTimeframeInteractionRef = useRef<
    | {
        nextTimeframe: string;
        previousTimeframe: string;
        selectedAtMs: number;
        sequence: number;
      }
    | undefined
  >(undefined);
  const previousProfilerInputsRef = useRef<
    Record<string, boolean | number | string | undefined> | undefined
  >(undefined);

  // Check if user has passkey
  useEffect(() => {
    if (!user) {
      setShowSecureAccountBanner(false);
    } else if (
      (passkeyCredentials && passkeyCredentials.length > 0) ||
      !user?.verified
    ) {
      setShowSecureAccountBanner(false);
    } else {
      setShowSecureAccountBanner(true);
    }
  }, [passkeyCredentials, user]);

  const memoizedMarketingCards = useMemo(() => {
    const cards =
      STATIC_CONTENT_CARDS_ENABLED && !brazeMarketingCarousel.length
        ? DefaultMarketingCards()
        : brazeMarketingCarousel;

    return [...cards].sort(sortNewestFirst);
  }, [brazeMarketingCarousel]);

  // Do More
  const memoizedShopWithCryptoCards = useMemo(() => {
    const cardsWithCoverImage = brazeShopWithCrypto.filter(
      card => card.extras?.cover_image,
    );

    const cards =
      STATIC_CONTENT_CARDS_ENABLED && !cardsWithCoverImage.length
        ? MockOffers()
        : cardsWithCoverImage;

    return [...cards].sort(sortNewestFirst);
  }, [brazeShopWithCrypto]);

  const quoteCurrency = getQuoteCurrency({
    portfolioQuoteCurrency,
    defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
  }).toUpperCase();

  useEffect(() => {
    return navigation.addListener('focus', () => {
      recordPerfEvent('screen.focus', {
        screen: 'HomeRoot',
      });
      if (!appIsLoading) {
        dispatch(updatePortfolioBalance());
      } // portfolio balance is updated in app init
    });
  }, [dispatch, navigation, appIsLoading]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await measurePerfAsync(
        'screen.home_root.on_refresh',
        async () => {
          await Promise.all([
            dispatch(
              refreshRatesForPortfolioPnl({context: 'homeRootOnRefresh'}) as any,
            ),
            dispatch(
              fetchFiatRateSeriesInterval({
                fiatCode: quoteCurrency,
                interval: '1D',
                coinForCacheCheck: 'btc',
                force: true,
              }) as any,
            ),
            dispatch(
              getAndDispatchUpdatedWalletBalances({
                context: 'homeRootOnRefresh',
                createTokenWalletWithFunds: true,
                skipRateUpdate: true,
              }) as any,
            ),
            dispatch(requestBrazeContentRefresh()),
          ]);

          const refreshedState = reduxStore.getState() as RootState;
          const refreshedKeys = refreshedState.WALLET.keys as Record<
            string,
            Key
          >;
          const refreshedWallets = (
            Object.values(refreshedKeys) as Key[]
          ).flatMap((key: Key) => key.wallets || []);
          const refreshedQuoteCurrency = getQuoteCurrency({
            portfolioQuoteCurrency: refreshedState.PORTFOLIO?.quoteCurrency,
            defaultAltCurrencyIsoCode:
              refreshedState.APP?.defaultAltCurrency?.isoCode,
          }).toUpperCase();

          await dispatch(
            maybePopulatePortfolioForWallets({
              // IMPORTANT: read wallets from the latest Redux state after the
              // balance refresh finishes so portfolio snapshots (and thus the
              // chart) are repopulated with up-to-date wallet balances and any
              // newly created token wallets with funds.
              wallets: refreshedWallets,
              quoteCurrency: refreshedQuoteCurrency,
            }) as any,
          );
        },
        {
          quoteCurrency,
          screen: 'HomeRoot',
          walletCount: wallets.length,
        },
      );
    } catch {
      dispatch(showBottomNotificationModal(BalanceUpdateError()));
    } finally {
      setRefreshing(false);
    }
  };

  const onPressTxpBadge = useCallback(() => {
    navigation
      .getParent<NativeStackNavigationProp<RootStackParamList>>()
      ?.navigate('TransactionProposalNotifications', {});
  }, [navigation]);

  useEffect(() => {
    if (keyMigrationFailure && !keyMigrationFailureModalHasBeenShown) {
      dispatch(setShowKeyMigrationFailureModal(true));
    }
  }, [dispatch, keyMigrationFailure, keyMigrationFailureModalHasBeenShown]);

  const scrollViewRef = useRef<ScrollView>(null);
  useScrollToTop(scrollViewRef);

  const onChartTimeframeInteraction = useCallback(
    (interaction: {
      nextTimeframe: string;
      previousTimeframe: string;
      selectedAtMs: number;
      sequence: number;
    }) => {
      lastChartTimeframeInteractionRef.current = interaction;
      recordPerfEvent('screen.home_root.timeframe_interaction_observed', {
        nextTimeframe: interaction.nextTimeframe,
        previousTimeframe: interaction.previousTimeframe,
        screen: 'HomeRoot',
        selectionSequence: interaction.sequence,
      });
    },
    [],
  );

  const profilerInputs = useMemo(
    () => ({
      appIsLoading,
      hasKeys: Boolean(hasKeys),
      homeCarouselConfigCount: homeCarouselConfig?.length || 0,
      keyCount: Object.keys(keys || {}).length,
      marketingCardCount: memoizedMarketingCards.length,
      pendingTxpCount: pendingTxps.length,
      quoteCurrency,
      refreshing,
      showArchaxBanner,
      showPortfolioAllocationSection,
      showPortfolioValue,
      showSecureAccountBanner,
      shopWithCryptoCardCount: memoizedShopWithCryptoCards.length,
      walletCount: wallets.length,
    }),
    [
      appIsLoading,
      hasKeys,
      homeCarouselConfig,
      keys,
      memoizedMarketingCards.length,
      memoizedShopWithCryptoCards.length,
      pendingTxps.length,
      quoteCurrency,
      refreshing,
      showArchaxBanner,
      showPortfolioAllocationSection,
      showPortfolioValue,
      showSecureAccountBanner,
      wallets.length,
    ],
  );

  const onProfilerRender = useCallback(
    (
      id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number,
      baseDuration: number,
      startTime: number,
      commitTime: number,
    ) => {
      const changeSummary = summarizeReactPerfSnapshotChanges({
        next: profilerInputs,
        previous: previousProfilerInputsRef.current,
      });
      previousProfilerInputsRef.current = profilerInputs;

      const interaction = lastChartTimeframeInteractionRef.current;
      const timeSinceTimeframeSelectionMs =
        interaction &&
        commitTime >= interaction.selectedAtMs &&
        commitTime - interaction.selectedAtMs <= 5000
          ? commitTime - interaction.selectedAtMs
          : undefined;

      recordPerfEvent('screen.home_root.react_commit', {
        actualDurationMs: actualDuration,
        addedKeyCount: changeSummary.addedKeyCount,
        baseDurationMs: baseDuration,
        changedKeyCount: changeSummary.changedKeyCount,
        changedKeyValueSample: changeSummary.changedKeyValueSample,
        changedKeysSample: changeSummary.changedKeysSample,
        commitLagMs: commitTime - startTime,
        hasRecentTimeframeSelection:
          typeof timeSinceTimeframeSelectionMs === 'number',
        interactionNextTimeframe: interaction?.nextTimeframe,
        interactionPreviousTimeframe: interaction?.previousTimeframe,
        interactionSequence: interaction?.sequence,
        nextKeyCount: changeSummary.nextKeyCount,
        phase,
        previousKeyCount: changeSummary.previousKeyCount,
        profilerId: id,
        removedKeyCount: changeSummary.removedKeyCount,
        screen: 'HomeRoot',
        timeSinceTimeframeSelectionMs,
      });
    },
    [profilerInputs],
  );

  return (
    <TabContainer>
      {appIsLoading ? null : (
        <Profiler id="HomeRoot.ScrollContent" onRender={onProfilerRender}>
          <>
            <HeaderContainer>
              <HeaderLeftContainer>
                <ScanButton />
              </HeaderLeftContainer>
              {pendingTxps.length ? (
                <ProposalBadgeContainer
                  onPress={onPressTxpBadge}
                  style={{marginRight: 8}}>
                  <ProposalBadge>{pendingTxps.length}</ProposalBadge>
                </ProposalBadgeContainer>
              ) : null}
              <ProfileButton />
            </HeaderContainer>
            <ScrollView
              ref={scrollViewRef}
              // Prevent iOS from injecting automatic top insets which creates a gap
              // between the Archax banner and the Home header when the scene is edge-to-edge
              contentInsetAdjustmentBehavior="never"
              refreshControl={
                <RefreshControl
                  tintColor={theme.dark ? White : SlateDark}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              }>
              {/* ////////////////////////////// PORTFOLIO BALANCE */}
              {showPortfolioValue ? (
                <HomeSection style={{marginTop: 20, marginBottom: 20}}>
                  <PortfolioBalance
                    onChartTimeframeInteraction={onChartTimeframeInteraction}
                  />
                </HomeSection>
              ) : null}

              {/* ////////////////////////////// CTA BUY SWAP RECEIVE SEND BUTTONS */}
              {hasKeys && showPortfolioValue ? (
                <HomeSection style={{marginBottom: 25}}>
                  <LinkingButtons
                    receive={{
                      cta: () => {
                        dispatch(
                          Analytics.track('Clicked Receive Crypto', {
                            context: 'HomeRoot',
                          }),
                        );
                        dispatch(receiveCrypto(navigation, 'HomeRoot'));
                      },
                    }}
                    send={{
                      cta: () => {
                        dispatch(
                          Analytics.track('Clicked Send Crypto', {
                            context: 'HomeRoot',
                          }),
                        );
                        dispatch(sendCrypto('HomeRoot'));
                      },
                    }}
                  />
                </HomeSection>
              ) : null}

            {/* ////////////////////////////// MARKETING */}
            {memoizedMarketingCards.length ? (
              <HomeSection>
                <MarketingCarousel contentCards={memoizedMarketingCards} />
              </HomeSection>
            ) : null}

            {/* ////////////////////////////// CRYPTO */}
            <HomeSection>
              <Crypto />
            </HomeSection>

            {/* ////////////////////////////// SECURE WITH PASSKEY */}
            {showSecureAccountBanner ? (
              <HomeSection>
                <SecurePasskeyBanner />
              </HomeSection>
            ) : null}

            {showPortfolioValue ? (
              <HomeSection>
                <AssetsSection />
              </HomeSection>
            ) : null}

            {showPortfolioValue && showPortfolioAllocationSection ? (
              <HomeSection>
                <AllocationSection />
              </HomeSection>
            ) : null}

            {/* ////////////////////////////// DO MORE */}
            {memoizedShopWithCryptoCards.length ? (
              <HomeSection
                style={{marginBottom: 20}}
                title={t('Do More')}
                // action={t('Shop all')}
                // onActionPress={() => {
                //   (navigation as any).navigate('Tabs', {screen: 'Shop'});
                //   dispatch(
                //     Analytics.track('Clicked Shop with Crypto', {
                //       context: 'HomeRoot',
                //     }),
                //   );
                // }}
              >
                <OffersCarousel contentCards={memoizedShopWithCryptoCards} />
              </HomeSection>
            ) : null}

            <HomeExchangeRatesSection
              currencyAbbreviation={currencyAbbreviation}
              navigation={navigation}
              showArchaxBanner={showArchaxBanner}
            />

              {showArchaxBanner && <ArchaxFooter />}
            </ScrollView>
          </>
        </Profiler>
      )}
      <KeyMigrationFailureModal />
    </TabContainer>
  );
};

export default withErrorFallback(HomeRoot, {includeHeader: true});
