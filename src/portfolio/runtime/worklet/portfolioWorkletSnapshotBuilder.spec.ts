import type {PortfolioPopulateWalletDebugTrace} from '../../core/engine/populateDebug';
import {
  createPortfolioSnapshotBuilderState,
  portfolioSnapshotBuilderFinish,
  portfolioSnapshotBuilderIngestPageWithSnapshotLimit,
} from './portfolioWorkletSnapshotBuilder';

const createDebugTrace = (
  walletId: string,
): PortfolioPopulateWalletDebugTrace => ({
  walletId,
  snapshotDebugMode: 'link',
  capturedAtMs: Date.now(),
  sessionStateBeforePrepareRows: [],
  builderSeedRows: [],
  ingestSeedRows: [],
  normalizedFilteredPageKeyRows: [],
  ingestLoopMutationRows: [],
  flushCurrentGroupRows: [],
  flushDirectResetWitnessRows: [],
  flushReturnWitnessRows: [],
  localMutationCanaryRows: [],
  stateMutationControlRows: [],
  directVsHelperParityRows: [],
  carryoverDecisionRows: [],
  groupAssemblyRows: [],
  requestLifecycleRows: [],
  fetchedTxRows: [],
  processedTxRows: [],
  emittedSnapshotRows: [],
});

const makeReceivedTx = (args: {
  txid: string;
  timeSeconds: number;
  blockheight: number;
  amountAtomic: string;
}) =>
  ({
    txid: args.txid,
    time: args.timeSeconds,
    blockheight: args.blockheight,
    action: 'received',
    amount: args.amountAtomic,
    fees: '0',
  }) as any;

const makeSentTx = (args: {
  txid: string;
  timeSeconds: number;
  blockheight: number;
  amountAtomic: string;
  feeAtomic?: string;
}) =>
  ({
    txid: args.txid,
    time: args.timeSeconds,
    blockheight: args.blockheight,
    action: 'sent',
    amount: args.amountAtomic,
    fees: args.feeAtomic ?? '0',
  }) as any;

describe('portfolioWorkletSnapshotBuilder return-struct flush state', () => {
  it('preserves the helper reset in the caller after the first group flush', () => {
    const walletId = 'wallet-1';
    const debugTrace = createDebugTrace(walletId);
    const state = createPortfolioSnapshotBuilderState({
      wallet: {
        walletId,
        walletName: 'Wallet 1',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      } as any,
      credentials: {
        walletId,
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      } as any,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: {} as any,
      nowMs: Date.UTC(2026, 0, 1),
      compressionEnabled: false,
      snapshotDebugMode: 'link',
      debugTrace,
    });

    const txs = [
      makeReceivedTx({
        txid: 'tx_1',
        timeSeconds: 1752782847,
        blockheight: 905990,
        amountAtomic: '1000',
      }),
      makeReceivedTx({
        txid: 'tx_2',
        timeSeconds: 1752788462,
        blockheight: 905993,
        amountAtomic: '1200',
      }),
      makeReceivedTx({
        txid: 'tx_3',
        timeSeconds: 1752792270,
        blockheight: 906002,
        amountAtomic: '1300',
      }),
    ];

    const result = portfolioSnapshotBuilderIngestPageWithSnapshotLimit(
      state,
      txs,
      undefined,
      'snapshots.processNextPage:test',
    );

    expect(result.consumedRawCount).toBe(3);

    const callerAfterFlush = debugTrace.flushReturnWitnessRows.find(
      row => row.stage === 'caller_after_flush_return_before_reseed',
    );
    expect(callerAfterFlush).toMatchObject({
      flushInvocationSeq: 1,
      groupInstanceSeqDirect: 2,
      groupLenDirect: 0,
      groupFirstTxidDirect: '',
      pageTxIdsAddedLenDirect: 0,
      carryoverSeedLenDirect: 0,
      groupKeyDirect: '',
      groupKeyIsNullDirect: true,
      consumedRawCountDirect: 1,
    });

    const callerCanary = debugTrace.localMutationCanaryRows.find(
      row => row.stage === 'caller_after_flush_return_before_reseed',
    );
    expect(callerCanary).toMatchObject({
      flushInvocationSeq: 1,
      localScalarCanary: 2,
      localArrayCanaryLen: 4,
    });
    expect(callerCanary?.localStringCanary).toContain(
      'helper_after_reset_complete',
    );

    const callerParity = debugTrace.directVsHelperParityRows.find(
      row => row.stage === 'caller_after_flush_return_before_reseed',
    );
    expect(callerParity).toMatchObject({
      flushInvocationSeq: 1,
      groupLenDirect: 0,
      groupLenViaSnapshot: 0,
      pageLenDirect: 0,
      pageLenViaSnapshot: 0,
      carryoverSeedLenDirect: 0,
      carryoverSeedLenViaSnapshot: 0,
      groupKeyDirect: '',
      groupKeyViaSnapshot: '',
      groupKeyIsNullDirect: true,
    });

    const helperAfterResetParity = debugTrace.directVsHelperParityRows.find(
      row => row.stage === 'helper_after_reset_complete',
    );
    expect(helperAfterResetParity).toMatchObject({
      flushInvocationSeq: 1,
      groupLenDirect: 0,
      groupLenViaSnapshot: 0,
      pageLenDirect: 0,
      pageLenViaSnapshot: 0,
      carryoverSeedLenDirect: 0,
      carryoverSeedLenViaSnapshot: 0,
      groupKeyDirect: '',
      groupKeyViaSnapshot: '',
      groupKeyIsNullDirect: true,
    });

    expect(debugTrace.flushCurrentGroupRows[0]).toMatchObject({
      groupKeyAfterReset: '',
      groupTxIdsAfterReset: [],
      pageTxIdsAddedAfterReset: [],
      carryoverSeedTxIdsAfterReset: [],
      groupMaxOriginalIndexAfterReset: null,
      consumedRawCountAfterReset: 1,
    });

    const reseedAfterFlush = debugTrace.ingestLoopMutationRows.find(
      row => row.mutation === 'reseed_group_key_after_flush',
    );
    expect(reseedAfterFlush).toMatchObject({
      txid: 'tx_2',
      groupKeyBefore: '',
      groupKeyAfter: '1752788462000:905993',
      groupTxIdsBefore: [],
      groupTxIdsAfter: [],
      pageTxIdsAddedBefore: [],
      pageTxIdsAddedAfter: [],
    });

    const appendAfterFlush = debugTrace.ingestLoopMutationRows.find(
      row => row.mutation === 'append_tx_to_group' && row.txid === 'tx_2',
    );
    expect(appendAfterFlush).toMatchObject({
      groupTxIdsBefore: [],
      groupTxIdsAfter: ['tx_2'],
      pageTxIdsAddedBefore: [],
      pageTxIdsAddedAfter: [],
    });

    portfolioSnapshotBuilderFinish(state, 'snapshots.finishWallet:test');
    expect(debugTrace.processedTxRows.map(row => row.txid)).toEqual([
      'tx_1',
      'tx_2',
      'tx_3',
    ]);
  });

  it('captures the prior compressed day balance before a newer day mutates builder state', () => {
    const walletId = 'wallet-2';
    const state = createPortfolioSnapshotBuilderState({
      wallet: {
        walletId,
        walletName: 'Wallet 2',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      } as any,
      credentials: {
        walletId,
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      } as any,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: {
        'USD:btc:ALL': {
          fetchedOn: Date.now(),
          points: [
            {ts: Date.parse('2024-01-01T00:00:00Z'), rate: 1},
            {ts: Date.parse('2024-01-02T00:00:00Z'), rate: 1},
          ],
        },
      } as any,
      nowMs: Date.parse('2024-05-01T00:00:00Z'),
      compressionEnabled: true,
      snapshotDebugMode: 'full',
    });

    const ingestResult = portfolioSnapshotBuilderIngestPageWithSnapshotLimit(
      state,
      [
        makeReceivedTx({
          txid: 'fund',
          timeSeconds: Math.floor(
            Date.parse('2024-01-01T00:00:00Z') / 1000,
          ),
          blockheight: 900001,
          amountAtomic: '1000',
        }),
        makeSentTx({
          txid: 'spend',
          timeSeconds: Math.floor(
            Date.parse('2024-01-02T00:00:00Z') / 1000,
          ),
          blockheight: 900002,
          amountAtomic: '400',
        }),
      ],
    );

    expect(portfolioSnapshotBuilderFinish(state)).toMatchObject([
      {
        eventType: 'daily',
        cryptoBalance: '1000',
        remainingCostBasisFiat: 0.00001,
        txIds: ['fund'],
      },
      {
        eventType: 'daily',
        cryptoBalance: '600',
        remainingCostBasisFiat: 0.000006,
        txIds: ['spend'],
      },
    ]);

    expect(ingestResult.snapshots).toEqual([]);
  });

  it('ignores debug request ids when no debug trace is attached', () => {
    const walletId = 'wallet-3';
    const state = createPortfolioSnapshotBuilderState({
      wallet: {
        walletId,
        walletName: 'Wallet 3',
        chain: 'btc',
        network: 'livenet',
        currencyAbbreviation: 'btc',
        balanceAtomic: '0',
        balanceFormatted: '0',
      } as any,
      credentials: {
        walletId,
        chain: 'btc',
        network: 'livenet',
        coin: 'btc',
      } as any,
      quoteCurrency: 'USD',
      fiatRateSeriesCache: {} as any,
      nowMs: Date.UTC(2026, 0, 1),
      compressionEnabled: false,
      snapshotDebugMode: 'link',
    });

    portfolioSnapshotBuilderIngestPageWithSnapshotLimit(
      state,
      [
        makeReceivedTx({
          txid: 'tx_1',
          timeSeconds: 1752782847,
          blockheight: 905990,
          amountAtomic: '1000',
        }),
        makeReceivedTx({
          txid: 'tx_2',
          timeSeconds: 1752788462,
          blockheight: 905993,
          amountAtomic: '1200',
        }),
      ],
      undefined,
      'snapshots.processNextPage:test',
    );

    expect(state.debugStateMutationControlCounter).toBe(0);
    expect(state.debugStateMutationControlLastStage).toBe('');
  });
});
