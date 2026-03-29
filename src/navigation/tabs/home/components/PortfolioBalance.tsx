import React, {
  Profiler,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import styled from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {BaseText, H2} from '../../../../components/styled/Text';
import {SlateDark, White} from '../../../../styles/colors';
import {formatFiatAmount} from '../../../../utils/helper-methods';
import {shouldUseCompactFiatAmountText} from '../../../../utils/fiatAmountText';
import InfoSvg from './InfoSvg';
import {
  ActiveOpacity,
  ScreenGutter,
} from '../../../../components/styled/Containers';
import {useAppDispatch, useAppSelector} from '../../../../utils/hooks';
import {
  showBottomNotificationModal,
  toggleHideAllBalances,
} from '../../../../store/app/app.actions';
import ChartChangeRow from '../../../../components/charts/ChartChangeRow';
import {DEFAULT_BALANCE_CHART_TIMEFRAME} from '../../../../components/charts/fiatTimeframes';
import {COINBASE_ENV} from '../../../../api/coinbase/coinbase.constants';
import {TouchableOpacity} from '@components/base/TouchableOpacity';
import {maskIfHidden} from '../../../../utils/hideBalances';
import {getVisibleKeysFromKeys} from '../../../../utils/portfolio/assets';
import type {FiatRateInterval} from '../../../../store/rate/rate.models';
import type {Key} from '../../../../store/wallet/wallet.models';
import {
  measurePerfSync,
  recordPerfEvent,
} from '../../../../utils/perfLogger';
import {summarizeReactPerfSnapshotChanges} from '../../../../utils/reactPerf';
import PortfolioBalanceChartSection from './PortfolioBalanceChartSection';

const PortfolioContainer = styled.View`
  justify-content: center;
  align-items: center;
  width: 100%;
`;

const PortfolioTopContent = styled.View<{$leftAligned?: boolean}>`
  width: 100%;
  padding: 0 ${ScreenGutter};
  align-items: ${({$leftAligned}) => ($leftAligned ? 'flex-start' : 'center')};
`;

const PortfolioBalanceHeader = styled(TouchableOpacity)`
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
`;

const PortfolioBalanceTitle = styled(BaseText)`
  margin-right: 3px;
  font-size: 13px;
  line-height: 18px;
  color: ${({theme: {dark}}) => (dark ? White : SlateDark)};
`;

const PortfolioBalanceText = styled(BaseText)<{$isCompact?: boolean}>`
  font-size: ${({$isCompact}) => ($isCompact ? '26px' : '39px')};
  font-weight: 700;
  line-height: ${({$isCompact}) => ($isCompact ? '38px' : '59px')};
  color: ${({theme}) => theme.colors.text};
  margin: 2px 0;
`;

const HiddenBalance = styled(H2)`
  line-height: 50px;
  margin: 6px 0;
`;

type PortfolioBalanceProps = {
  onChartTimeframeInteraction?: (interaction: {
    nextTimeframe: FiatRateInterval;
    previousTimeframe: FiatRateInterval;
    selectedAtMs: number;
    sequence: number;
  }) => void;
};

const TIMEFRAME_INTERACTION_WINDOW_MS = 5000;

const PortfolioBalance = ({
  onChartTimeframeInteraction,
}: PortfolioBalanceProps) => {
  const {t} = useTranslation();
  const dispatch = useAppDispatch();
  const coinbaseBalance =
    useAppSelector(({COINBASE}) => COINBASE.balance[COINBASE_ENV]) || 0.0;
  const keys = useAppSelector(({WALLET}) => WALLET.keys) as Record<string, Key>;
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const hideAllBalances = useAppSelector(({APP}) => APP.hideAllBalances);
  const homeCarouselConfig = useAppSelector(({APP}) => APP.homeCarouselConfig);

  const [selectedChartBalance, setSelectedChartBalance] = useState<
    number | undefined
  >();
  const [chartChangeRowData, setChartChangeRowData] = useState<{
    percent: number;
    deltaFiatFormatted?: string;
    rangeLabel?: string;
  }>();
  const [hasChartData, setHasChartData] = useState(false);
  const selectedChartTimeframeRef = useRef<FiatRateInterval>(
    DEFAULT_BALANCE_CHART_TIMEFRAME,
  );
  const lastTimeframeInteractionRef = useRef<
    | {
        nextTimeframe: FiatRateInterval;
        previousTimeframe: FiatRateInterval;
        selectedAtMs: number;
        sequence: number;
      }
    | undefined
  >(undefined);
  const previousProfilerInputsRef = useRef<
    Record<string, boolean | number | string | undefined> | undefined
  >(undefined);

  const visibleKeys = useMemo(
    () =>
      measurePerfSync(
        'screen.home_root.visible_keys',
        () => getVisibleKeysFromKeys(keys, homeCarouselConfig),
        {
          homeCarouselConfigCount: homeCarouselConfig?.length,
          screen: 'HomeRoot',
        },
      ),
    [homeCarouselConfig, keys],
  );

  const visibleCurrentBalance = useMemo(
    () =>
      visibleKeys.reduce((total, key) => total + (key.totalBalance || 0), 0),
    [visibleKeys],
  );
  const visibleKeyIdsSig = useMemo(() => {
    return visibleKeys
      .map(key => String(key?.id || ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .join(',');
  }, [visibleKeys]);

  const totalBalanceIncludingCoinbase = visibleCurrentBalance + coinbaseBalance;
  const shouldLeftAlignTopSection = hasChartData && !hideAllBalances;

  const handleChartTimeframeInteraction = useCallback(
    (interaction: {
      nextTimeframe: FiatRateInterval;
      previousTimeframe: FiatRateInterval;
      selectedAtMs: number;
      sequence: number;
    }) => {
      selectedChartTimeframeRef.current = interaction.nextTimeframe;
      lastTimeframeInteractionRef.current = interaction;
      onChartTimeframeInteraction?.(interaction);
    },
    [onChartTimeframeInteraction],
  );

  const handleHasChartDataChange = useCallback((nextHasChartData: boolean) => {
    setHasChartData(previous =>
      previous === nextHasChartData ? previous : nextHasChartData,
    );
  }, []);

  const displayedPortfolioBalance =
    typeof selectedChartBalance === 'number'
      ? selectedChartBalance
      : totalBalanceIncludingCoinbase;
  const formattedPortfolioBalance = useMemo(() => {
    return formatFiatAmount(
      displayedPortfolioBalance,
      defaultAltCurrency.isoCode,
      {
        currencyDisplay: 'symbol',
      },
    );
  }, [defaultAltCurrency.isoCode, displayedPortfolioBalance]);
  const shouldUseCompactPortfolioBalanceText = useMemo(() => {
    return shouldUseCompactFiatAmountText(formattedPortfolioBalance);
  }, [formattedPortfolioBalance]);

  const showPortfolioBalanceInfoModal = () => {
    dispatch(
      showBottomNotificationModal({
        type: 'info',
        title: t('Portfolio balance'),
        message: t(
          'Your Portfolio Balance is the total of all your crypto assets.',
        ),
        enableBackdropDismiss: true,
        actions: [
          {
            text: t('GOT IT'),
            action: () => null,
            primary: true,
          },
        ],
      }),
    );
  };

  const profilerInputs = useMemo(
    () => ({
      hasChartData,
      hideAllBalances,
      selectedTimeframe: selectedChartTimeframeRef.current,
      showChangeRow: !!chartChangeRowData,
      showTopSection: shouldLeftAlignTopSection,
      usesSelectedChartBalance: typeof selectedChartBalance === 'number',
      visibleKeyCount: visibleKeys.length,
    }),
    [
      chartChangeRowData,
      hasChartData,
      hideAllBalances,
      selectedChartBalance,
      shouldLeftAlignTopSection,
      visibleKeys.length,
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

      const interaction = lastTimeframeInteractionRef.current;
      const timeSinceTimeframeSelectionMs =
        interaction &&
        commitTime >= interaction.selectedAtMs &&
        commitTime - interaction.selectedAtMs <= TIMEFRAME_INTERACTION_WINDOW_MS
          ? commitTime - interaction.selectedAtMs
          : undefined;

      recordPerfEvent('screen.home_root.portfolio_balance.react_commit', {
        actualDurationMs: actualDuration,
        addedKeyCount: changeSummary.addedKeyCount,
        baseDurationMs: baseDuration,
        changedKeyCount: changeSummary.changedKeyCount,
        changedKeyValueSample: changeSummary.changedKeyValueSample,
        changedKeysSample: changeSummary.changedKeysSample,
        commitLagMs: commitTime - startTime,
        currentSelectedTimeframe: selectedChartTimeframeRef.current,
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
        timeSinceTimeframeSelectionMs,
      });
    },
    [profilerInputs],
  );

  return (
    <Profiler id="HomeRoot.PortfolioBalance" onRender={onProfilerRender}>
      <PortfolioContainer>
        <PortfolioTopContent $leftAligned={shouldLeftAlignTopSection}>
          <PortfolioBalanceHeader
            activeOpacity={ActiveOpacity}
            onPress={showPortfolioBalanceInfoModal}>
            <PortfolioBalanceTitle>
              {t('Portfolio Balance')}
            </PortfolioBalanceTitle>
            <InfoSvg width={16} height={16} />
          </PortfolioBalanceHeader>
          <TouchableOpacity
            onLongPress={() => {
              dispatch(toggleHideAllBalances());
            }}>
            {!hideAllBalances ? (
              <PortfolioBalanceText
                $isCompact={shouldUseCompactPortfolioBalanceText}>
                {formattedPortfolioBalance}
              </PortfolioBalanceText>
            ) : (
              <HiddenBalance>
                {maskIfHidden(true, totalBalanceIncludingCoinbase)}
              </HiddenBalance>
            )}
          </TouchableOpacity>
        </PortfolioTopContent>

        {shouldLeftAlignTopSection ? (
          <ChartChangeRow
            percent={chartChangeRowData?.percent ?? 0}
            deltaFiatFormatted={chartChangeRowData?.deltaFiatFormatted}
            rangeLabel={chartChangeRowData?.rangeLabel}
            style={[
              {
                width: '100%',
                justifyContent: 'flex-start',
                paddingLeft: 12,
              },
              !chartChangeRowData ? {opacity: 0} : null,
            ]}
          />
        ) : null}

        <PortfolioBalanceChartSection
          defaultAltCurrencyIsoCode={defaultAltCurrency.isoCode}
          hideAllBalances={hideAllBalances}
          homeCarouselConfig={homeCarouselConfig}
          keys={keys}
          onChangeRowData={setChartChangeRowData}
          onChartTimeframeInteraction={handleChartTimeframeInteraction}
          onHasChartDataChange={handleHasChartDataChange}
          onSelectedBalanceChange={setSelectedChartBalance}
          visibleKeyIdsSig={visibleKeyIdsSig}
        />
      </PortfolioContainer>
    </Profiler>
  );
};

export default PortfolioBalance;
