jest.mock('../../constants', () => ({
  Network: {
    mainnet: 'livenet',
  },
}));

jest.mock('../../constants/currencies', () => ({
  BitpaySupportedCoins: {
    btc: {unitInfo: {unitDecimals: 8, unitToSatoshi: 1e8}},
    eth: {unitInfo: {unitDecimals: 18, unitToSatoshi: 1e18}},
    usdc: {unitInfo: {unitDecimals: 6, unitToSatoshi: 1e6}},
  },
  BitpaySupportedUtxoCoins: {
    btc: {unitInfo: {unitDecimals: 8, unitToSatoshi: 1e8}},
  },
  BitpaySupportedTokens: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48_e': {
      unitInfo: {unitDecimals: 6, unitToSatoshi: 1e6},
    },
  },
}));

jest.mock('./rate', () => ({
  getFiatRateBaselineTsForTimeframe: jest.fn(),
  getFiatRateFromSeriesCacheAtTimestamp: jest.fn(),
}));

jest.mock('../../store/wallet/utils/currency', () => ({
  IsSVMChain: (chain: string) => String(chain || '').toLowerCase() === 'sol',
}));

jest.mock('./core/pnl/analysis', () => ({
  buildPnlAnalysisSeries: jest.fn(() => ({points: []})),
}));

jest.mock('./core/pnl/rates', () => ({
  normalizeFiatRateSeriesCoin: (coin: string) =>
    String(coin || '')
      .trim()
      .toLowerCase(),
}));

jest.mock('./core/format', () => ({
  formatBigIntDecimal: jest.fn(() => '0'),
}));

jest.mock('../helper-methods', () => {
  const unitStringToAtomicBigInt = (
    unitString: string,
    unitDecimals: number,
  ): bigint => {
    const raw = String(unitString || '0')
      .replace(/,/g, '')
      .trim();
    if (!raw) {
      return 0n;
    }

    const isNegative = raw.startsWith('-');
    const unsigned = raw.replace(/^[-+]/, '');
    const [wholeRaw, fractionRaw = ''] = unsigned.split('.');
    const whole = wholeRaw || '0';
    const fraction = fractionRaw
      .padEnd(unitDecimals, '0')
      .slice(0, unitDecimals);
    const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    const atomic = BigInt(combined);

    return isNegative ? -atomic : atomic;
  };

  return {
    formatCurrencyAbbreviation: (value: string) => value,
    formatFiatAmount: () => '0',
    atomicToUnitString: () => '0',
    getCurrencyAbbreviation: (name: string, chain: string) => {
      const normalizedName = String(name || '').toLowerCase();
      const normalizedChain = String(chain || '').toLowerCase();
      const suffixByChain: {[chain: string]: string} = {
        eth: 'e',
        matic: 'm',
        arb: 'arb',
        base: 'base',
        op: 'op',
        sol: 'sol',
      };
      const isToken =
        (normalizedName !== normalizedChain && normalizedName !== 'eth') ||
        normalizedChain === 'sol';

      if (isToken) {
        return `${normalizedName}_${
          suffixByChain[normalizedChain] || normalizedChain
        }`;
      }

      return normalizedName;
    },
    calculatePercentageDifference: () => 0,
    getRateByCurrencyName: (
      rates: {[key: string]: unknown} | undefined,
      name: string,
      chain?: string,
      tokenAddress?: string,
    ) => {
      const tokenKey = String(tokenAddress || '').toLowerCase();
      const coinKey = String(name || '').toLowerCase();
      const chainKey = String(chain || '').toLowerCase();

      return (
        (tokenKey ? rates?.[tokenKey] : undefined) ||
        rates?.[`${coinKey}|${chainKey}`] ||
        rates?.[coinKey]
      );
    },
    unitStringToAtomicBigInt,
  };
});

import type {BalanceSnapshot} from '../../store/portfolio/portfolio.models';
import type {Wallet} from '../../store/wallet/wallet.models';
import {
  buildPnlCurrentRatesByCoinFromPortfolioSnapshots,
  buildPnlWalletInputsFromPortfolioSnapshots,
  buildPnlWalletInputsFromPortfolioSnapshotsAsync,
} from './assets';

const USDC_TOKEN_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SVM_TOKEN_ADDRESS = 'AbCDeFGHJKLMNPQRSTuvWXYZ123456789';

const makeWallet = (args: {
  id: string;
  chain: string;
  currencyAbbreviation: string;
  walletName?: string;
  network?: string;
  tokenAddress?: string;
  tokenDecimals?: number;
}): Wallet =>
  ({
    id: args.id,
    network: args.network ?? 'livenet',
    chain: args.chain,
    currencyAbbreviation: args.currencyAbbreviation,
    walletName: args.walletName ?? args.id,
    tokenAddress: args.tokenAddress,
    credentials: args.tokenAddress
      ? {
          token: {
            decimals: args.tokenDecimals ?? 6,
          },
        }
      : undefined,
    balance: {
      sat: 0,
      crypto: '0',
    },
  } as Wallet);

const makeSnapshot = (args: {
  id: string;
  chain: string;
  coin: string;
  assetId: string;
  timestamp: number;
  cryptoBalance: string;
  remainingCostBasisFiat: number;
  costBasisRateFiat: number;
  quoteCurrency?: string;
}): BalanceSnapshot =>
  ({
    id: args.id,
    chain: args.chain,
    coin: args.coin,
    network: 'livenet',
    assetId: args.assetId,
    timestamp: args.timestamp,
    eventType: 'tx',
    cryptoBalance: args.cryptoBalance,
    avgCostFiatPerUnit: args.costBasisRateFiat,
    remainingCostBasisFiat: args.remainingCostBasisFiat,
    unrealizedPnlFiat: 0,
    costBasisRateFiat: args.costBasisRateFiat,
    quoteCurrency: args.quoteCurrency ?? 'USD',
  } as BalanceSnapshot);

const makeRate = (rate: number, code = 'USD') => [
  {
    code,
    fetchedOn: 0,
    name: code,
    rate,
    ts: 0,
  },
];

describe('Pnl wallet input builders', () => {
  it('keeps sync, async, and live current-rate preparation aligned', async () => {
    const wallets = [
      makeWallet({
        id: 'wallet-btc',
        chain: 'btc',
        currencyAbbreviation: 'btc',
        walletName: 'BTC Wallet',
      }),
      makeWallet({
        id: 'wallet-usdc',
        chain: 'eth',
        currencyAbbreviation: 'usdc',
        walletName: 'USDC Wallet',
        tokenAddress: USDC_TOKEN_ADDRESS,
      }),
      makeWallet({
        id: 'wallet-no-snaps',
        chain: 'eth',
        currencyAbbreviation: 'eth',
        walletName: 'No Snapshot Wallet',
      }),
      makeWallet({
        id: 'wallet-testnet',
        chain: 'btc',
        currencyAbbreviation: 'btc',
        walletName: 'Testnet Wallet',
        network: 'testnet',
      }),
    ];

    const snapshotsByWalletId = {
      'wallet-btc': [
        makeSnapshot({
          id: 'btc-later',
          chain: 'btc',
          coin: 'btc',
          assetId: 'btc:btc',
          timestamp: 2_000,
          cryptoBalance: '0.25',
          remainingCostBasisFiat: 12_000,
          costBasisRateFiat: 48_000,
        }),
        makeSnapshot({
          id: 'btc-earlier',
          chain: 'btc',
          coin: 'btc',
          assetId: 'btc:btc',
          timestamp: 1_000,
          cryptoBalance: '0.2',
          remainingCostBasisFiat: 9_000,
          costBasisRateFiat: 45_000,
        }),
      ],
      'wallet-usdc': [
        makeSnapshot({
          id: 'usdc-start',
          chain: 'eth',
          coin: 'usdc',
          assetId: `eth:usdc:${USDC_TOKEN_ADDRESS}`,
          timestamp: 1_500,
          cryptoBalance: '125.5',
          remainingCostBasisFiat: 125.5,
          costBasisRateFiat: 1,
        }),
      ],
      'wallet-testnet': [
        makeSnapshot({
          id: 'btc-testnet',
          chain: 'btc',
          coin: 'btc',
          assetId: 'btc:btc',
          timestamp: 1_250,
          cryptoBalance: '1',
          remainingCostBasisFiat: 1,
          costBasisRateFiat: 1,
        }),
      ],
    };

    const rates = {
      btc: makeRate(65_000),
      [USDC_TOKEN_ADDRESS]: makeRate(1),
      eth: makeRate(3_000),
    };

    const sync = buildPnlWalletInputsFromPortfolioSnapshots({
      snapshotsByWalletId,
      wallets,
      quoteCurrency: '',
      rates,
      fiatRateSeriesCache: {},
      nowMs: 5_000,
    });
    const yieldControl = jest.fn(async () => undefined);
    const asyncBuilt = await buildPnlWalletInputsFromPortfolioSnapshotsAsync(
      {
        snapshotsByWalletId,
        wallets,
        quoteCurrency: '',
        rates,
        fiatRateSeriesCache: {},
        nowMs: 5_000,
      },
      {
        yieldEveryWallets: 1,
        yieldEverySnapshots: 1,
        yieldControl,
      },
    );
    const liveRates = buildPnlCurrentRatesByCoinFromPortfolioSnapshots({
      snapshotsByWalletId,
      wallets,
      quoteCurrency: '',
      rates,
    });

    expect(asyncBuilt).toEqual(sync);
    expect(sync.currentRatesByCoin).toEqual(liveRates);
    expect(sync.quoteCurrency).toBe('USD');
    expect(sync.wallets.map(wallet => wallet.walletId)).toEqual([
      'wallet-btc',
      'wallet-usdc',
    ]);
    expect(
      sync.wallets[0].snapshots.map(snapshot => snapshot.timestamp),
    ).toEqual([1_000, 2_000]);
    expect(sync.currentRatesByCoin).toEqual({
      btc: 65_000,
      usdc: 1,
    });
    expect(yieldControl).toHaveBeenCalled();
  });

  it('returns the same empty result when fiatRateSeriesCache is missing', async () => {
    const wallets = [
      makeWallet({
        id: 'wallet-btc',
        chain: 'btc',
        currencyAbbreviation: 'btc',
      }),
    ];
    const snapshotsByWalletId = {
      'wallet-btc': [
        makeSnapshot({
          id: 'btc-only',
          chain: 'btc',
          coin: 'btc',
          assetId: 'btc:btc',
          timestamp: 1_000,
          cryptoBalance: '1',
          remainingCostBasisFiat: 40_000,
          costBasisRateFiat: 40_000,
          quoteCurrency: 'EUR',
        }),
      ],
    };

    const sync = buildPnlWalletInputsFromPortfolioSnapshots({
      snapshotsByWalletId,
      wallets,
      quoteCurrency: '',
      rates: {
        btc: makeRate(50_000, 'EUR'),
      },
    });
    const asyncBuilt = await buildPnlWalletInputsFromPortfolioSnapshotsAsync({
      snapshotsByWalletId,
      wallets,
      quoteCurrency: '',
      rates: {
        btc: makeRate(50_000, 'EUR'),
      },
    });

    expect(asyncBuilt).toEqual(sync);
    expect(sync).toEqual({
      wallets: [],
      currentRatesByCoin: {},
      quoteCurrency: 'EUR',
    });
  });

  it('preserves SVM token address casing in stored snapshot asset ids', () => {
    const wallet = makeWallet({
      id: 'wallet-sol-usdc',
      chain: 'sol',
      currencyAbbreviation: 'usdc',
      walletName: 'Sol USDC Wallet',
      tokenAddress: SVM_TOKEN_ADDRESS,
      tokenDecimals: 6,
    });
    const snapshotsByWalletId = {
      [wallet.id]: [
        makeSnapshot({
          id: 'sol-usdc-1',
          chain: 'sol',
          coin: 'usdc',
          assetId: `sol:usdc:${SVM_TOKEN_ADDRESS}`,
          timestamp: 1_000,
          cryptoBalance: '10',
          remainingCostBasisFiat: 10,
          costBasisRateFiat: 1,
        }),
      ],
    };

    const result = buildPnlWalletInputsFromPortfolioSnapshots({
      snapshotsByWalletId,
      wallets: [wallet],
      quoteCurrency: 'USD',
      rates: {
        [SVM_TOKEN_ADDRESS]: makeRate(1),
      },
      fiatRateSeriesCache: {},
      nowMs: 5_000,
    });

    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0].credentials.token?.address).toBe(
      SVM_TOKEN_ADDRESS,
    );
    expect(result.wallets[0].snapshots[0].assetId).toBe(
      `sol:usdc:${SVM_TOKEN_ADDRESS}`,
    );
  });

  it('aborts async wallet input preparation at yield boundaries', async () => {
    const wallets = [
      makeWallet({
        id: 'wallet-btc',
        chain: 'btc',
        currencyAbbreviation: 'btc',
      }),
    ];
    const snapshotsByWalletId = {
      'wallet-btc': [
        makeSnapshot({
          id: 'btc-1',
          chain: 'btc',
          coin: 'btc',
          assetId: 'btc:btc',
          timestamp: 1_000,
          cryptoBalance: '0.5',
          remainingCostBasisFiat: 20_000,
          costBasisRateFiat: 40_000,
        }),
        makeSnapshot({
          id: 'btc-2',
          chain: 'btc',
          coin: 'btc',
          assetId: 'btc:btc',
          timestamp: 2_000,
          cryptoBalance: '1',
          remainingCostBasisFiat: 40_000,
          costBasisRateFiat: 40_000,
        }),
      ],
    };
    const controller = new AbortController();
    const yieldControl = jest.fn(async () => {
      controller.abort();
    });

    await expect(
      buildPnlWalletInputsFromPortfolioSnapshotsAsync(
        {
          snapshotsByWalletId,
          wallets,
          quoteCurrency: 'USD',
          fiatRateSeriesCache: {},
        },
        {
          signal: controller.signal,
          yieldEveryWallets: 1,
          yieldEverySnapshots: 1,
          yieldControl,
        },
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(yieldControl).toHaveBeenCalled();
  });
});
