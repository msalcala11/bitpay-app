import {useEffect, useMemo, useState} from 'react';
import type {Key} from '../../../store/wallet/wallet.models';
import {useAppDispatch, useAppSelector} from '../../../utils/hooks';
import {
  getLastFiniteNumber,
  getStoredWalletRequestSignature,
  mapWalletsToStoredWallets,
  resolvePortfolioQuoteCurrency,
  runPortfolioChartQuery,
} from '../common';
import {buildKeyPercentageDifferenceMap} from '../selectors/buildKeySummariesFromAnalysis';

export function usePortfolioKeyPercentages(args: {keys: Key[]}) {
  const dispatch = useAppDispatch();
  const defaultAltCurrency = useAppSelector(({APP}) => APP.defaultAltCurrency);
  const portfolioQuoteCurrency = useAppSelector(({PORTFOLIO}) => PORTFOLIO.quoteCurrency);
  const populateRefreshToken = useAppSelector(({PORTFOLIO}) => {
    const status = PORTFOLIO.populateStatus;

    return [
      typeof PORTFOLIO.lastPopulatedAt === 'number'
        ? String(PORTFOLIO.lastPopulatedAt)
        : '',
      status?.inProgress ? '1' : '0',
      status?.currentWalletId || '',
      typeof status?.walletsCompleted === 'number'
        ? String(status.walletsCompleted)
        : '',
    ].join('|');
  });
  const populateInProgress = useAppSelector(
    ({PORTFOLIO}) => !!PORTFOLIO.populateStatus?.inProgress,
  );

  const quoteCurrency = useMemo(() => {
    return resolvePortfolioQuoteCurrency({
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
      return {
        keyId: key.id,
        liveFiatTotal: key.totalBalance || 0,
        storedWallets: mapped.storedWallets,
      };
    });
  }, [args.keys, dispatch]);

  const requestKey = useMemo(() => {
    return [
      quoteCurrency,
      ...keyInputs.map(
        input =>
          `${input.keyId}:${input.liveFiatTotal}:${getStoredWalletRequestSignature(
            input.storedWallets,
          )}`,
      ),
    ].join('|');
  }, [keyInputs, quoteCurrency]);

  const [currentMap, setCurrentMap] = useState<Record<string, number | null>>({});
  const [committedMap, setCommittedMap] = useState<Record<string, number | null>>({});

  useEffect(() => {
    setCurrentMap({});
    setCommittedMap({});
  }, [requestKey]);

  useEffect(() => {
    if (!keyInputs.length) {
      return;
    }

    let cancelled = false;

    Promise.all(
      keyInputs.map(async input => {
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
        setCurrentMap(nextMap);

        if (!populateInProgress) {
          setCommittedMap(nextMap);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [keyInputs, populateInProgress, populateRefreshToken, quoteCurrency, requestKey]);

  return populateInProgress ? committedMap : currentMap;
}

export default usePortfolioKeyPercentages;
