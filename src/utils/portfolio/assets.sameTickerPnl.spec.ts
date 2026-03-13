jest.mock('../../constants', () => ({
  Network: {
    mainnet: 'livenet',
  },
}));

jest.mock('../../constants/currencies', () => ({
  BitpaySupportedCoins: {
    btc: {unitInfo: {unitDecimals: 8, unitToSatoshi: 1e8}},
    eth: {unitInfo: {unitDecimals: 18, unitToSatoshi: 1e18}},
    sol: {unitInfo: {unitDecimals: 9, unitToSatoshi: 1e9}},
  },
  BitpaySupportedUtxoCoins: {},
  BitpaySupportedTokens: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48_e': {
      unitInfo: {unitDecimals: 6, unitToSatoshi: 1e6},
    },
    'epjfwdd5aufqssqem2q_sol': {
      unitInfo: {unitDecimals: 6, unitToSatoshi: 1e6},
    },
  },
}));

jest.mock('../../managers/TokenManager', () => ({
  tokenManager: {
    getTokenOptions: () => ({tokenDataByAddress: {}}),
  },
}));

jest.mock('./rate', () => ({
  getFiatRateBaselineTsForTimeframe: jest.fn(() => 0),
  getFiatRateFromSeriesCacheAtTimestamp: jest.fn(() => 1),
}));

jest.mock('./core/pnl/analysis', () => ({
  buildPnlAnalysisSeries: jest.fn(),
}));

jest.mock('./core/pnl/rates', () => ({
  normalizeFiatRateSeriesCoin: jest.fn((coin: string) =>
    String(coin || '').toLowerCase(),
  ),
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

  const atomicToUnitString = (
    atomicValue: bigint | string | number,
    unitDecimals: number,
  ): string => {
    const atomic = BigInt(String(atomicValue || 0));
    const isNegative = atomic < 0n;
    const unsigned = isNegative ? -atomic : atomic;
    const raw = unsigned.toString().padStart(unitDecimals + 1, '0');
    const whole = raw.slice(0, raw.length - unitDecimals) || '0';
    const fraction = raw.slice(raw.length - unitDecimals).replace(/0+$/, '');
    const value = fraction ? `${whole}.${fraction}` : whole;
    return isNegative ? `-${value}` : value;
  };

  const rateByAssetKey: {[key: string]: number} = {
    'eth:usdc:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 1,
    'sol:usdc:epjfwdd5aufqssqem2q': 1.25,
  };

  return {
    formatCurrencyAbbreviation: (value: string) => value,
    formatFiatAmount: (amount: number) => String(amount),
    atomicToUnitString,
    getCurrencyAbbreviation: (name: string, chain: string) => {
      const normalizedName = String(name || '').toLowerCase();
      const normalizedChain = String(chain || '').toLowerCase();
      const suffixByChain: {[chain: string]: string} = {
        eth: 'e',
        sol: 'sol',
      };
      return `${normalizedName}_${suffixByChain[normalizedChain] || normalizedChain}`;
    },
    calculatePercentageDifference: () => 0,
    getRateByCurrencyName: (
      _rates: unknown,
      coin: string,
      chain: string,
      tokenAddress?: string,
    ) => {
      const key = `${String(chain || '').toLowerCase()}:${String(
        coin || '',
      ).toLowerCase()}:${String(tokenAddress || '').toLowerCase()}`;
      const rate = rateByAssetKey[key];
      return typeof rate === 'number'
        ? [{code: 'USD', rate}]
        : [{code: 'USD', rate: 1}];
    },
    unitStringToAtomicBigInt,
  };
});

import {
  buildAssetRowItemsFromPortfolioSnapshots,
  getPortfolioPnlChangeForTimeframeFromPortfolioSnapshots,
} from './assets';
import {buildPnlAnalysisSeries} from './core/pnl/analysis';

const buildPnlAnalysisSeriesMock = buildPnlAnalysisSeries as jest.Mock;

const ETH_USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SOL_USDC_ADDRESS = 'epjfwdd5aufqssqem2q';

const makeTokenWallet = (args: {
  id: string;
  chain: 'eth' | 'sol';
  tokenAddress: string;
  crypto: string;
  sat: number;
}): any => ({
  id: args.id,
  walletName: args.id,
  network: 'livenet',
  chain: args.chain,
  currencyAbbreviation: 'usdc',
  tokenAddress: args.tokenAddress,
  credentials: {
    chain: args.chain,
    coin: 'usdc',
    network: 'livenet',
    token: {
      address: args.tokenAddress,
      decimals: 6,
    },
  },
  balance: {
    crypto: args.crypto,
    sat: args.sat,
    satConfirmed: args.sat,
    satConfirmedLocked: 0,
    satPending: 0,
  },
});

const makeSnapshot = (args: {
  id: string;
  walletId: string;
  chain: 'eth' | 'sol';
  tokenAddress: string;
  timestamp: number;
  cryptoBalance: string;
  remainingCostBasisFiat: number;
  costBasisRateFiat: number;
}): any => ({
  id: args.id,
  walletId: args.walletId,
  chain: args.chain,
  coin: 'usdc',
  network: 'livenet',
  assetId: `${args.chain}:usdc:${args.tokenAddress.toLowerCase()}`,
  timestamp: args.timestamp,
  eventType: 'tx',
  cryptoBalance: args.cryptoBalance,
  remainingCostBasisFiat: args.remainingCostBasisFiat,
  unrealizedPnlFiat: 0,
  costBasisRateFiat: args.costBasisRateFiat,
  quoteCurrency: 'USD',
});

describe('assets same-ticker current-rate overrides', () => {
  beforeEach(() => {
    buildPnlAnalysisSeriesMock.mockReset();
    buildPnlAnalysisSeriesMock.mockReturnValue({
      points: [
        {
          totalUnrealizedPnlFiat: 25,
          totalPnlPercent: 50,
          byWalletId: {},
        },
      ],
    });
  });

  it('passes asset-specific current-rate overrides through portfolio summary PnL', () => {
    const ethWallet = makeTokenWallet({
      id: 'wallet-eth-usdc',
      chain: 'eth',
      tokenAddress: ETH_USDC_ADDRESS,
      crypto: '1',
      sat: 1_000_000,
    });
    const solWallet = makeTokenWallet({
      id: 'wallet-sol-usdc',
      chain: 'sol',
      tokenAddress: SOL_USDC_ADDRESS,
      crypto: '2',
      sat: 2_000_000,
    });

    const result = getPortfolioPnlChangeForTimeframeFromPortfolioSnapshots({
      snapshotsByWalletId: {
        'wallet-eth-usdc': [
          makeSnapshot({
            id: 'snap-eth-usdc',
            walletId: 'wallet-eth-usdc',
            chain: 'eth',
            tokenAddress: ETH_USDC_ADDRESS,
            timestamp: 1000,
            cryptoBalance: '1',
            remainingCostBasisFiat: 1,
            costBasisRateFiat: 1,
          }),
        ],
        'wallet-sol-usdc': [
          makeSnapshot({
            id: 'snap-sol-usdc',
            walletId: 'wallet-sol-usdc',
            chain: 'sol',
            tokenAddress: SOL_USDC_ADDRESS,
            timestamp: 1000,
            cryptoBalance: '2',
            remainingCostBasisFiat: 2,
            costBasisRateFiat: 1,
          }),
        ],
      },
      wallets: [ethWallet, solWallet],
      quoteCurrency: 'USD',
      timeframe: '1W',
      rates: {} as any,
      fiatRateSeriesCache: {},
      nowMs: 2000,
    });

    expect(result.available).toBe(true);
    expect(buildPnlAnalysisSeriesMock).toHaveBeenCalledTimes(1);
    expect(buildPnlAnalysisSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRatesByAssetId: {
          [`eth:usdc:${ETH_USDC_ADDRESS.toLowerCase()}`]: 1,
          [`sol:usdc:${SOL_USDC_ADDRESS.toLowerCase()}`]: 1.25,
        },
      }),
    );
  });

  it('passes asset-specific current-rate overrides through asset row PnL', () => {
    const ethWallet = makeTokenWallet({
      id: 'wallet-eth-usdc',
      chain: 'eth',
      tokenAddress: ETH_USDC_ADDRESS,
      crypto: '1',
      sat: 1_000_000,
    });
    const solWallet = makeTokenWallet({
      id: 'wallet-sol-usdc',
      chain: 'sol',
      tokenAddress: SOL_USDC_ADDRESS,
      crypto: '2',
      sat: 2_000_000,
    });

    buildAssetRowItemsFromPortfolioSnapshots({
      snapshotsByWalletId: {
        'wallet-eth-usdc': [
          makeSnapshot({
            id: 'snap-eth-usdc',
            walletId: 'wallet-eth-usdc',
            chain: 'eth',
            tokenAddress: ETH_USDC_ADDRESS,
            timestamp: 1000,
            cryptoBalance: '1',
            remainingCostBasisFiat: 1,
            costBasisRateFiat: 1,
          }),
        ],
        'wallet-sol-usdc': [
          makeSnapshot({
            id: 'snap-sol-usdc',
            walletId: 'wallet-sol-usdc',
            chain: 'sol',
            tokenAddress: SOL_USDC_ADDRESS,
            timestamp: 1000,
            cryptoBalance: '2',
            remainingCostBasisFiat: 2,
            costBasisRateFiat: 1,
          }),
        ],
      },
      wallets: [ethWallet, solWallet],
      quoteCurrency: 'USD',
      gainLossMode: '1W',
      rates: {} as any,
      fiatRateSeriesCache: {},
      nowMs: 2000,
    });

    expect(buildPnlAnalysisSeriesMock).toHaveBeenCalledTimes(1);
    expect(buildPnlAnalysisSeriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentRatesByAssetId: {
          [`eth:usdc:${ETH_USDC_ADDRESS.toLowerCase()}`]: 1,
          [`sol:usdc:${SOL_USDC_ADDRESS.toLowerCase()}`]: 1.25,
        },
      }),
    );
  });
});
