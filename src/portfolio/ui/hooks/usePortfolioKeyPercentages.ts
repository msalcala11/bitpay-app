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
  resolveCommittedPortfolioQuoteCurrency,
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
  const portfolioQuoteCurrency = useAppSelector(
    ({PORTFOLIO}) => PORTFOLIO.quoteCurrency,
  );
  const rates = useAppSelector(({RATE}) => RATE.rates);
  const committedRevisionToken = useAppSelector(({PORTFOLIO}) =>
    buildCommittedPortfolioRevisionToken({
      quoteCurrency: PORTFOLIO.quoteCurrency,
      lastPopulatedAt: PORTFOLIO.lastPopulatedAt,
    }),
  );

  const quoteCurrency = useMemo(() => {
    return resolveCommittedPortfolioQuoteCurrency({
      portfolioQuoteCurrency,
      defaultAltCurrencyIsoCode: defaultAltCurrency?.isoCode,
    });
  }, [defaultAltCurrency?.isoCode, portfolioQuoteCurrency]);

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
  }, [keyInputs, quoteCurrency]);
  const stableKeyInputsRef = useRef(keyInputs);
  stableKeyInputsRef.current = keyInputs;

  const [currentMap, setCurrentMap] = useState<Record<string, number | null>>(
    {},
  );
  const [committedMap, setCommittedMap] = useState<
    Record<string, number | null>
  >({});

  useEffect(() => {
    const stableKeyInputs = stableKeyInputsRef.current;

    if (!stableKeyInputs.length) {
      return;
    }

    let cancelled = false;

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
        setCurrentMap(prev =>
          arePercentageMapsEqual(prev, nextMap) ? prev : nextMap,
        );
        setCommittedMap(prev =>
          arePercentageMapsEqual(prev, nextMap) ? prev : nextMap,
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
  }, [committedRevisionToken, quoteCurrency, requestKey]);

  return Object.keys(currentMap).length ? currentMap : committedMap;
}

export default usePortfolioKeyPercentages;
