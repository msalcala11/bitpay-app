import buildAssetPnlDebugPayload from './buildAssetPnlDebugPayload';

describe('buildAssetPnlDebugPayload', () => {
  it('redacts wallet identifiers, request keys, and addresses from copied diagnostics', () => {
    const payload = buildAssetPnlDebugPayload({
      surface: 'asset_list',
      assetKey: 'usdc',
      gainLossMode: '1D',
      quoteCurrency: 'USD',
      storedWallets: [
        {
          walletId: 'wallet-123',
          credentials: {
            walletId: 'wallet-123',
            chain: 'eth',
            coin: 'usdc',
          },
          summary: {
            walletId: 'wallet-123',
            walletName: 'Wallet A',
            chain: 'eth',
            network: 'livenet',
            currencyAbbreviation: 'usdc',
            tokenAddress: '0xAbC123',
            balanceAtomic: '1000000',
            balanceFormatted: '1',
          },
          addedAt: 0,
        } as any,
      ],
      requestKey: 'USD|1D|2|wallet-123:eth:usdc:0xAbC123|eth:usdc:0xAbC123:1',
      currentRatesSignature: 'eth:usdc:0xAbC123:1',
      currentRatesByAssetId: {
        'eth:usdc:0xabc123': 1,
      },
      analysis: {
        timeframe: '1D',
        quoteCurrency: 'USD',
        driverAssetId: 'eth:usdc:0xabc123',
        driverCoin: 'usdc',
        analysisWindow: {
          startTs: 100,
          endTs: 200,
          nowMs: 250,
        },
        assetIds: ['eth:usdc:0xabc123'],
        coins: ['usdc'],
        wallets: [],
        points: [],
        assetSummaries: [],
        totalSummary: {
          pnlStart: 0,
          pnlEnd: 0,
          pnlChange: 0,
          pnlPercent: 0,
        },
      },
      baseDebugPayload: {
        rowWalletIds: ['wallet-123', 'wallet-123'],
        rowAssetIds: ['eth:usdc:0xabc123'],
        wallets: [
          {
            walletId: 'wallet-123',
            tokenAddress: '0xAbC123',
          },
        ],
      },
      displayedMetrics: {
        fiatBalance: 1,
        pnlChange: 0.2,
        pnlPercent: 20,
        hasRate: true,
        hasPnl: true,
      },
    });

    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('wallet-123');
    expect(serialized).not.toContain('0xAbC123');
    expect(serialized).not.toContain('0xabc123');
    expect((payload as any).asset.rowWalletIds).toEqual([
      expect.stringMatching(/^<redacted:rowwalletids:/),
      expect.stringMatching(/^<redacted:rowwalletids:/),
    ]);
    expect((payload as any).analysisInputs.requestKey).toEqual(
      expect.stringMatching(/^<redacted:requestkey:/),
    );
    expect((payload as any).analysisInputs.currentRatesSignature).toEqual(
      expect.stringMatching(/^<redacted:currentratessignature:/),
    );
    expect((payload as any).canonicalResults.data.analysisWindow).toEqual({
      startTs: 100,
      endTs: 200,
      nowMs: 250,
    });
    expect((payload as any).asset.rowWalletIds[0]).toBe(
      (payload as any).asset.rowWalletIds[1],
    );
  });
});
