import React, {useCallback, useMemo, useState} from 'react';
import {
  InteractionManager,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import styled from 'styled-components/native';
import {useTheme} from 'styled-components/native';
import {useTranslation} from 'react-i18next';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import {useAppDispatch, useAppSelector} from '../../../../../utils/hooks';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import type {FiatRateInterval} from '../../../../../store/rate/rate.models';
import {storage} from '../../../../../store';
import {clearRateState} from '../../../../../store/rate/rate.actions';

type RatesDebugScreenProps = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.RATES_DEBUG
>;

const RatesDebugContainer = styled(SafeAreaView)`
  flex: 1;
  background-color: ${({theme}) => theme.colors.background};
`;

const HeaderContainer = styled.View`
  padding: 12px;
`;

const HeaderText = styled.Text`
  color: ${({theme}) => theme.colors.text};
  font-size: 14px;
  line-height: 18px;
`;

const IntervalRow = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
  margin-top: 10px;
`;

const IntervalButton = styled(Pressable)<{selected?: boolean}>`
  padding: 8px 10px;
  border-radius: 10px;
  border-width: 1px;
  border-color: ${({theme, selected}) =>
    selected ? theme.colors.primary : theme.colors.border};
  margin-right: 8px;
  margin-bottom: 8px;
`;

const IntervalButtonText = styled.Text<{selected?: boolean}>`
  color: ${({theme, selected}) =>
    selected ? theme.colors.primary : theme.colors.text};
  font-size: 12px;
`;

const SourceRow = styled.View`
  flex-direction: row;
  flex-wrap: wrap;
  margin-top: 10px;
`;

const SourceButton = styled(Pressable)<{selected?: boolean}>`
  padding: 8px 10px;
  border-radius: 10px;
  border-width: 1px;
  border-color: ${({theme, selected}) =>
    selected ? theme.colors.primary : theme.colors.border};
  margin-right: 8px;
  margin-bottom: 8px;
`;

const SourceButtonText = styled.Text<{selected?: boolean}>`
  color: ${({theme, selected}) =>
    selected ? theme.colors.primary : theme.colors.text};
  font-size: 12px;
`;

const JsonLineText = styled.Text`
  padding: 12px;
  font-size: 12px;
  line-height: 16px;
  font-family: ${Platform.OS === 'ios' ? 'Menlo' : 'monospace'};
  color: ${({theme}) => theme.colors.text};
`;

const GenerateButton = styled(Pressable)`
  margin-top: 10px;
  align-self: flex-start;
  padding: 10px 12px;
  border-radius: 999px;
  border-width: 1px;
  border-color: ${({theme}) => theme.colors.border};
`;

const GenerateButtonText = styled.Text`
  color: ${({theme}) => theme.colors.text};
  font-size: 13px;
`;

const ButtonRow = styled.View`
  flex-direction: row;
  align-items: center;
  margin-top: 10px;
`;

const ButtonSpacer = styled.View`
  width: 10px;
`;

const RatesDebug = ({}: RatesDebugScreenProps) => {
  const {t} = useTranslation();
  const theme = useTheme();
  const dispatch = useAppDispatch();

  const liveRateState = useAppSelector(({RATE}) => RATE);

  const intervals: FiatRateInterval[] = useMemo(
    () => ['ALL', '1D', '1W', '1M', '3M', '1Y', '5Y'],
    [],
  );

  const [selectedInterval, setSelectedInterval] =
    useState<FiatRateInterval>('ALL');
  const [source, setSource] = useState<'persisted' | 'redux'>('persisted');
  const [rawJsonString, setRawJsonString] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState<boolean>(false);

  const [meta, setMeta] = useState<{
    hasPersistRoot: boolean;
    rootStringLength: number;
    rateRawType: string;
    rateParsedType: string;
    rateParseDepth: number;
    rateStringLength: number;
    rateTopLevelKeys: number;
    fiatRateSeriesCacheKeys: number;
    parseError?: string;
  } | null>(null);

  const generate = useCallback(() => {
    setIsGenerating(true);
    setRawJsonString('');

    const task = InteractionManager.runAfterInteractions(() => {
      try {
        const root = storage.getString('persist:root');
        const hasPersistRoot = !!root;
        const rootStringLength = root?.length ?? 0;
        let rateString = '';
        let rateObj: any = {};
        let rateRawType = 'undefined';
        let rateParsedType = 'undefined';
        let rateParseDepth = 0;
        let parseError: string | undefined;

        const parseJsonDeep = (input: unknown): unknown => {
          let current: unknown = input;
          for (let i = 0; i < 3; i++) {
            if (typeof current !== 'string' || !current) {
              break;
            }
            try {
              current = JSON.parse(current);
              rateParseDepth = i + 1;
            } catch (e) {
              parseError = e instanceof Error ? e.message : String(e);
              break;
            }
          }
          return current;
        };

        if (source === 'redux') {
          rateRawType = 'redux';
          rateObj = liveRateState;
        } else {
          if (root) {
            const parsedRoot = JSON.parse(root);
            const rateRaw = parsedRoot?.RATE;
            rateRawType = Array.isArray(rateRaw) ? 'array' : typeof rateRaw;

            if (typeof rateRaw === 'string') {
              rateString = rateRaw;
              if (rateString) {
                const parsed = parseJsonDeep(rateString);
                rateObj =
                  parsed && typeof parsed === 'object' ? parsed : parsed;
              }
            } else if (rateRaw && typeof rateRaw === 'object') {
              // Some persist setups store reducer slices as objects directly.
              rateObj = rateRaw;
              try {
                rateString = JSON.stringify(rateRaw);
              } catch (_) {
                rateString = '';
              }
            } else {
              rateString = '';
              rateObj = {};
            }
          }
        }

        const fiatRateSeriesCache = rateObj?.fiatRateSeriesCache || {};
        const fiatRateSeriesCacheKeys = Object.keys(fiatRateSeriesCache).length;
        const rateTopLevelKeys = Object.keys(rateObj || {}).length;
        const rateStringLength = source === 'redux' ? -1 : rateString.length;
        rateParsedType = Array.isArray(rateObj) ? 'array' : typeof rateObj;

        setMeta({
          hasPersistRoot,
          rootStringLength,
          rateRawType,
          rateParsedType,
          rateParseDepth,
          rateStringLength,
          rateTopLevelKeys,
          fiatRateSeriesCacheKeys,
          ...(parseError ? {parseError} : {}),
        });

        const intervalSuffix = `:${selectedInterval}`;
        const intervalKeys: string[] = [];
        const intervalDataSummary: Record<string, unknown> = {};
        const summarizeSeries = (series: any) => {
          const points = Array.isArray(series?.points) ? series.points : [];
          const first = points.length ? points[0] : undefined;
          const last = points.length ? points[points.length - 1] : undefined;
          return {
            fetchedOn: series?.fetchedOn,
            pointsCount: points.length,
            firstPoint: first,
            lastPoint: last,
          };
        };

        for (const [key, value] of Object.entries(fiatRateSeriesCache)) {
          if (!key.endsWith(intervalSuffix)) {
            continue;
          }
          intervalKeys.push(key);
          intervalDataSummary[key] = summarizeSeries(value);
        }

        const json = {
          source,
          interval: selectedInterval,
          persisted: {
            hasPersistRoot,
            rateStringLength,
            rateTopLevelKeys,
            fiatRateSeriesCacheKeys,
            rateParsedType,
            rateParseDepth,
          },
          cacheKeysForInterval: intervalKeys.length,
          intervalKeys,
          intervalDataSummary,
        };
        setRawJsonString(JSON.stringify(json, null, 2));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setRawJsonString(
          JSON.stringify(
            {
              error: 'Failed to stringify RATE interval data',
              interval: selectedInterval,
              message,
            },
            null,
            2,
          ),
        );
      } finally {
        setIsGenerating(false);
      }
    });

    return () => task.cancel();
  }, [liveRateState, selectedInterval, source]);

  const clearRates = useCallback(() => {
    if (isGenerating) {
      return;
    }

    setIsGenerating(true);
    setRawJsonString('');

    const task = InteractionManager.runAfterInteractions(() => {
      try {
        dispatch(clearRateState());

        const root = storage.getString('persist:root');
        if (root) {
          const parsedRoot = JSON.parse(root);
          const existingRateRaw = parsedRoot?.RATE;

          const clearedRateState = {
            rates: {},
            lastDayRates: {},
            fiatRateSeriesCache: {},
            balanceCacheKey: {},
            ratesCacheKey: {},
          };

          let newRateRaw: any = JSON.stringify(clearedRateState);

          if (typeof existingRateRaw === 'string') {
            try {
              const parsedOnce = JSON.parse(existingRateRaw);
              const needsDoubleEncoding = typeof parsedOnce === 'string';
              newRateRaw = needsDoubleEncoding
                ? JSON.stringify(JSON.stringify(clearedRateState))
                : JSON.stringify(clearedRateState);
            } catch (_) {
              newRateRaw = JSON.stringify(clearedRateState);
            }
          } else if (existingRateRaw && typeof existingRateRaw === 'object') {
            newRateRaw = clearedRateState;
          }

          parsedRoot.RATE = newRateRaw;
          storage.set('persist:root', JSON.stringify(parsedRoot));
        }

        setMeta(null);
        setRawJsonString(
          JSON.stringify(
            {
              cleared: true,
            },
            null,
            2,
          ),
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setRawJsonString(
          JSON.stringify(
            {
              error: 'Failed to clear RATE state',
              message,
            },
            null,
            2,
          ),
        );
      } finally {
        setIsGenerating(false);
      }
    });

    return () => task.cancel();
  }, [dispatch, isGenerating]);

  const displayJson = useMemo(() => {
    // Avoid rendering an extremely large Text node if cache is huge.
    const limit = 200000;
    if (rawJsonString.length > limit) {
      return (
        rawJsonString.slice(0, limit) +
        `\n...TRUNCATED (${rawJsonString.length} chars)`
      );
    }
    return rawJsonString;
  }, [rawJsonString]);

  return (
    <RatesDebugContainer>
      <HeaderContainer>
        <HeaderText>{t('Rates Debug Loaded')}</HeaderText>
        <HeaderText>
          persisted: {meta?.hasPersistRoot ? 'yes' : 'no'} | root length:{' '}
          {meta?.rootStringLength ?? '-'} | RATE raw: {meta?.rateRawType ?? '-'}{' '}
          | RATE parsed: {meta?.rateParsedType ?? '-'} (depth{' '}
          {meta?.rateParseDepth ?? '-'}) | RATE length:{' '}
          {meta?.rateStringLength ?? '-'} | RATE keys:{' '}
          {meta?.rateTopLevelKeys ?? '-'} | fiatRateSeriesCache keys:{' '}
          {meta?.fiatRateSeriesCacheKeys ?? '-'}
        </HeaderText>

        {meta?.parseError ? (
          <HeaderText>parseError: {meta.parseError}</HeaderText>
        ) : null}

        <HeaderText>
          interval: {selectedInterval} {isGenerating ? '(generating...)' : ''}
        </HeaderText>

        <HeaderText>source: {source}</HeaderText>

        <SourceRow>
          <SourceButton
            selected={source === 'persisted'}
            onPress={() => setSource('persisted')}>
            <SourceButtonText selected={source === 'persisted'}>
              persisted
            </SourceButtonText>
          </SourceButton>
          <SourceButton
            selected={source === 'redux'}
            onPress={() => setSource('redux')}>
            <SourceButtonText selected={source === 'redux'}>
              redux
            </SourceButtonText>
          </SourceButton>
        </SourceRow>

        <ButtonRow>
          <GenerateButton onPress={() => (isGenerating ? null : generate())}>
            <GenerateButtonText>{t('Generate JSON')}</GenerateButtonText>
          </GenerateButton>
          <ButtonSpacer />
          <GenerateButton onPress={() => (isGenerating ? null : clearRates())}>
            <GenerateButtonText>{t('Clear Rates')}</GenerateButtonText>
          </GenerateButton>
        </ButtonRow>

        <IntervalRow>
          {intervals.map(interval => (
            <IntervalButton
              key={interval}
              selected={interval === selectedInterval}
              onPress={() => setSelectedInterval(interval)}>
              <IntervalButtonText selected={interval === selectedInterval}>
                {interval}
              </IntervalButtonText>
            </IntervalButton>
          ))}
        </IntervalRow>
      </HeaderContainer>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{
          paddingBottom: 40,
          backgroundColor: theme.colors.background,
        }}>
        <JsonLineText selectable>
          {displayJson || t('Tap Generate JSON')}
        </JsonLineText>
      </ScrollView>
    </RatesDebugContainer>
  );
};

export default RatesDebug;
