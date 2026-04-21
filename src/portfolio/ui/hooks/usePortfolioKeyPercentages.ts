import {useEffect, useMemo, useRef, useState} from 'react';
import type {Key} from '../../../store/wallet/wallet.models';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  buildCurrentRatesByAssetId,
  buildCommittedPortfolioRevisionToken,
  getCurrentRatesByAssetIdSignature,
  getLastFiniteNumber,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolveActivePortfolioDisplayQuoteCurrency,
  resolveCurrentRatesAsOfMs,
  runPortfolioChartQuery,
} from '../common';
import {buildKeyPercentageDifferenceMap} from '../selectors/buildKeySummariesFromAnalysis';

function arePercentageMapsEqual(
  left: Record<string, number | null>,
  right: Record<string, number | null>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(key => left[key] === right[key]);
}

export function usePortfolioKeyPercentages(args: {keys: Key[]}) {
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const ratesUpdatedAt = useAppSelector(({RATE}) => RATE.ratesUpdatedAt);
  const committedRevisionToken = useAppSelector(({PORTFOLIO}) =>
    buildCommittedPortfolioRevisionToken({
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    }),
  );

  const quoteCurrency = useMemo(() => {
    return resolveActivePortfolioDisplayQuoteCurrency({
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode]);
  const fallbackAsOfMsRef = useRef<number>(Date.now());
  const asOfMs = useMemo(() => {
    return (
      resolveCurrentRatesAsOfMs({
        ratesUpdatedAt,
        rates,
      }) ?? fallbackAsOfMsRef.current
    );
  }, [rates, ratesUpdatedAt]);

  const keyInputs = useMemo(() => {
    return (args.keys || []).map(key => {
      const wallets = (key.wallets || []).filter(
        wallet => !wallet.hideWallet && !wallet.hideWalletByAccount,
      );
      const mapped = mapWalletsToStoredWallets({dispatch, wallets});
      const currentRatesByAssetId = buildCurrentRatesByAssetId({
        storedWallets: mapped.storedWallets,
        quoteCurrency,
        rates,
      });
      return {
        keyId: key.id,
        liveFiatTotal: key.totalBalance || 0,
        storedWallets: mapped.storedWallets,
        currentRatesByAssetId,
        currentRatesSignature: getCurrentRatesByAssetIdSignature(
          currentRatesByAssetId,
        ),
      };
    });
  }, [args.keys, dispatch, quoteCurrency, rates]);

  const requestKey = useMemo(() => {
    return [
      quoteCurrency,
      String(asOfMs),
      ...keyInputs.map(
        input =>
          [
            input.keyId,
            input.liveFiatTotal,
            getStoredWalletRequestSignature(input.storedWallets),
            input.currentRatesSignature,
          ].join(':'),
      ),
    ].join('|');
  }, [asOfMs, keyInputs, quoteCurrency]);
  const stableKeyInputsRef = useRef(keyInputs);
  stableKeyInputsRef.current = keyInputs;
  const emptyPercentageMapRef = useRef<Record<string, number | null>>({});
  const cachedMapByRequestKeyRef = useRef<
    Map<string, Record<string, number | null>>
  >(new Map());

  const [currentMapState, setCurrentMapState] = useState<{
    requestKey: string;
    value: Record<string, number | null>;
  }>({
    requestKey: '',
    value: emptyPercentageMapRef.current,
  });

  useEffect(() => {
    const stableKeyInputs = stableKeyInputsRef.current;

    if (!stableKeyInputs.length) {
      setCurrentMapState({
        requestKey,
        value: emptyPercentageMapRef.current,
      });
      return;
    }

    let cancelled = false;
    setCurrentMapState(prev =>
      prev.requestKey === requestKey
        ? prev
        : {
            requestKey,
            value:
              cachedMapByRequestKeyRef.current.get(requestKey) ||
              emptyPercentageMapRef.current,
          },
    );

    Promise.all(
      stableKeyInputs.map(async input => {
        if (!input.storedWallets.length) {
          return {
            keyId: input.keyId,
            liveFiatTotal: input.liveFiatTotal,
          };
        }

        const chart = await runPortfolioChartQuery({
          wallets: input.storedWallets,
          quoteCurrency,
          timeframe: '1D',
          maxPoints: 2,
          currentRatesByAssetId: input.currentRatesByAssetId,
          asOfMs,
        });

        return {
          keyId: input.keyId,
          liveFiatTotal: input.liveFiatTotal,
          totalFiatBalance: getLastFiniteNumber(chart.totalFiatBalance),
          totalPnlPercent: getLastFiniteNumber(chart.totalPnlPercent),
        };
      }),
    )
      .then(results => {
        if (cancelled) {
          return;
        }

        const nextMap = buildKeyPercentageDifferenceMap({results});
        const cachedMap = cachedMapByRequestKeyRef.current.get(requestKey);
        if (!cachedMap || !arePercentageMapsEqual(cachedMap, nextMap)) {
          cachedMapByRequestKeyRef.current.set(requestKey, nextMap);
        }
        setCurrentMapState(prev =>
          prev.requestKey === requestKey &&
          arePercentageMapsEqual(prev.value, nextMap)
            ? prev
            : {
                requestKey,
                value: nextMap,
              },
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [asOfMs, committedRevisionToken, quoteCurrency, requestKey]);

  if (currentMapState.requestKey === requestKey) {
    return currentMapState.value;
  }

  return (
    cachedMapByRequestKeyRef.current.get(requestKey) ||
    emptyPercentageMapRef.current
  );
}

export default usePortfolioKeyPercentages;
