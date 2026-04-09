import React, {useMemo, useState} from 'react';
import {ActivityIndicator, Pressable} from 'react-native';
import styled from 'styled-components/native';
import {NativeStackScreenProps} from '@react-navigation/native-stack';
import Button from '../../../../../components/button/Button';
import {
  BaseText,
  H5,
  Paragraph,
  Small,
  Smallest,
} from '../../../../../components/styled/Text';
import {
  CardContainer,
  Hr,
  ScreenContainer,
} from '../../../../../components/styled/Containers';
import {
  fetchWalletTxHistoryPagesOnWorker,
  probeMmkvRoundTripOnWorker,
  type WorkerMmkvRoundTripResult,
  type WorkerTxHistoryBatchResult,
  type WorkletsTxHistoryWalletSnapshot,
} from '../../../../../lib/workletsBundleModeDemo';
import {AboutGroupParamList, AboutScreens} from '../AboutGroup';
import {useAppSelector} from '../../../../../utils/hooks';
import type {Key} from '../../../../../store/wallet/wallet.models';

type Props = NativeStackScreenProps<
  AboutGroupParamList,
  AboutScreens.WORKLETS_BUNDLE_MODE_DEMO
>;

type DemoWalletOption = WorkletsTxHistoryWalletSnapshot & {
  selectionId: string;
  walletLabel: string;
  walletSubLabel: string;
};

const Container = styled(ScreenContainer)`
  background-color: ${({theme}) => theme.colors.background};
`;

const Content = styled.ScrollView`
  flex: 1;
  padding: 15px;
`;

const Card = styled(CardContainer)`
  padding: 16px;
  margin-bottom: 16px;
`;

const SectionTitle = styled(H5).attrs(() => ({bold: true}))`
  margin-bottom: 8px;
`;

const SectionBody = styled(Paragraph)`
  margin-bottom: 12px;
`;

const MetaText = styled(Small)`
  margin-bottom: 6px;
`;

const RawOutput = styled(BaseText)`
  font-size: 12px;
  line-height: 18px;
`;

const Spacer = styled.View`
  height: 12px;
`;

const StatusRow = styled.View`
  flex-direction: row;
  align-items: center;
`;

const LoadingText = styled(Small)`
  margin-left: 10px;
`;

const WalletOption = styled(Pressable)<{$selected: boolean}>`
  border-width: 1px;
  border-color: ${({$selected, theme}) =>
    $selected ? theme.colors.primary : theme.colors.border};
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 10px;
  background-color: ${({$selected, theme}) =>
    $selected
      ? theme.dark
        ? 'rgba(18, 54, 181, 0.24)'
        : 'rgba(18, 54, 181, 0.08)'
      : 'transparent'};
`;

const WalletOptionTitle = styled(BaseText)`
  color: ${({theme}) => theme.colors.text};
  font-size: 14px;
  line-height: 18px;
  font-weight: 600;
`;

const WalletOptionSubTitle = styled(BaseText)`
  color: ${({theme}) => theme.colors.description};
  font-size: 12px;
  line-height: 16px;
  margin-top: 4px;
`;

const SelectedBadge = styled(Smallest)`
  color: ${({theme}) => theme.colors.primary};
  margin-top: 6px;
`;

const PageTitle = styled(BaseText)`
  color: ${({theme}) => theme.colors.text};
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
`;

const TxPreviewRow = styled.View`
  padding: 10px 0;
`;

const TxPreviewTitle = styled(BaseText)`
  color: ${({theme}) => theme.colors.text};
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  margin-top: 8px;
`;

const TxPreviewMeta = styled(Smallest)`
  margin-top: 4px;
`;

const toErrorMessage = (err: unknown) => {
  if (err instanceof Error) {
    return err.message;
  }

  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const truncateMiddle = (value: string | undefined, visible = 10) => {
  if (!value) {
    return 'n/a';
  }

  if (value.length <= visible * 2 + 1) {
    return value;
  }

  return `${value.slice(0, visible)}…${value.slice(-visible)}`;
};

const isMainnetNetwork = (network: string | undefined) => {
  return network === 'livenet' || network === 'mainnet';
};

const isBtcWallet = (coin: string | undefined, chain: string | undefined) => {
  const normalizedCoin = String(coin || '').toLowerCase();
  const normalizedChain = String(chain || '').toLowerCase();

  return normalizedCoin === 'btc' || normalizedChain === 'btc';
};

const buildWalletOption = (
  wallet: any,
  keyName?: string,
): DemoWalletOption | null => {
  const credentials = wallet?.credentials;
  const requestPrivKey = credentials?.requestPrivKey;
  const requestPubKey = credentials?.requestPubKey;
  const copayerId = credentials?.copayerId;
  const walletId = credentials?.walletId || wallet?.id;

  if (!requestPrivKey || !copayerId || !walletId) {
    return null;
  }

  try {
    if (
      typeof credentials?.isComplete === 'function' &&
      !credentials.isComplete()
    ) {
      return null;
    }
  } catch {
    return null;
  }

  if (wallet?.pendingTssSession) {
    return null;
  }

  const tokenAddress = credentials?.token?.address;
  const multisigContractAddress =
    credentials?.multisigEthInfo?.multisigContractAddress;
  const walletName = wallet?.walletName || credentials?.walletName;
  const chain = wallet?.chain || credentials?.chain;
  const network = wallet?.network || credentials?.network;
  const coin = credentials?.coin || wallet?.currencyAbbreviation;

  if (!isMainnetNetwork(network) || !isBtcWallet(coin, chain)) {
    return null;
  }

  const selectionId = [
    walletId,
    copayerId,
    tokenAddress || '',
    multisigContractAddress || '',
  ].join(':');

  const walletLabel =
    walletName ||
    [wallet?.currencyAbbreviation, chain].filter(Boolean).join(' ') ||
    'Wallet';

  const walletSubLabel = [
    keyName || 'My Key',
    chain ? String(chain).toUpperCase() : undefined,
    network,
    tokenAddress ? 'Token wallet' : undefined,
    multisigContractAddress ? 'Multisig contract wallet' : undefined,
  ]
    .filter(Boolean)
    .join(' • ');

  return {
    selectionId,
    walletLabel,
    walletSubLabel,
    walletId,
    walletName,
    keyName,
    chain,
    coin,
    network,
    copayerId,
    requestPrivKey,
    requestPubKey,
    tokenAddress,
    multisigContractAddress,
  };
};

const WorkletsBundleModeDemo = (_props: Props) => {
  const [mmkvLoading, setMmkvLoading] = useState(false);
  const [mmkvError, setMmkvError] = useState<string | null>(null);
  const [mmkvResult, setMmkvResult] = useState<WorkerMmkvRoundTripResult | null>(
    null,
  );
  const [txHistoryLoading, setTxHistoryLoading] = useState(false);
  const [txHistoryError, setTxHistoryError] = useState<string | null>(null);
  const [txHistoryResult, setTxHistoryResult] =
    useState<WorkerTxHistoryBatchResult | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

  const walletKeys = useAppSelector(({WALLET}) => WALLET?.keys || {});

  const walletOptions = useMemo(() => {
    const options: DemoWalletOption[] = [];

    for (const key of Object.values(walletKeys || {}) as Key[]) {
      const nextKeyName = key?.keyName || 'My Key';
      const wallets = Array.isArray(key?.wallets) ? key.wallets : [];

      for (const wallet of wallets) {
        const option = buildWalletOption(wallet, nextKeyName);
        if (option) {
          options.push(option);
        }
      }
    }

    return options.sort((a, b) => {
      const left = `${a.walletLabel} ${a.walletSubLabel}`.toLowerCase();
      const right = `${b.walletLabel} ${b.walletSubLabel}`.toLowerCase();
      return left.localeCompare(right);
    });
  }, [walletKeys]);

  const selectedWallet = useMemo(() => {
    return (
      walletOptions.find(wallet => wallet.selectionId === selectedWalletId) ||
      walletOptions[0] ||
      null
    );
  }, [selectedWalletId, walletOptions]);

  React.useEffect(() => {
    if (!walletOptions.length) {
      setSelectedWalletId(null);
      setTxHistoryResult(null);
      return;
    }

    const hasSelectedWallet = walletOptions.some(
      wallet => wallet.selectionId === selectedWalletId,
    );

    if (!selectedWalletId || !hasSelectedWallet) {
      setSelectedWalletId(walletOptions[0].selectionId);
    }
  }, [selectedWalletId, walletOptions]);

  const handleRunMmkvProbe = async () => {
    setMmkvLoading(true);
    setMmkvError(null);
    setMmkvResult(null);

    try {
      const nextMmkvResult = await probeMmkvRoundTripOnWorker();
      setMmkvResult(nextMmkvResult);
    } catch (err: unknown) {
      setMmkvError(toErrorMessage(err));
    } finally {
      setMmkvLoading(false);
    }
  };

  const handleRunTxHistory = async () => {
    if (!selectedWallet) {
      return;
    }

    setTxHistoryLoading(true);
    setTxHistoryError(null);
    setTxHistoryResult(null);

    try {
      const nextResult = await fetchWalletTxHistoryPagesOnWorker({
        wallet: selectedWallet,
        initialSkip: 0,
        pageSize: 10,
        pageCount: 3,
      });
      setTxHistoryResult(nextResult);
    } catch (err: unknown) {
      setTxHistoryError(toErrorMessage(err));
    } finally {
      setTxHistoryLoading(false);
    }
  };

  return (
    <Container>
      <Content contentContainerStyle={{paddingBottom: 32}}>
        <Card>
          <SectionTitle>Reduced Bundle Mode worker proofs</SectionTitle>
          <SectionBody>
            This screen keeps the bundle-mode POC focused on two concrete
            worker-runtime checks: an MMKV write/read roundtrip on the
            background JS runtime, and an end-to-end txhistory flow that signs
            BWS `/v1/txhistory/` requests with transferred Nitro crypto handles.
          </SectionBody>
          <SectionBody>
            The MMKV probe is isolated to a demo-specific storage instance, so
            it can verify worker access without touching the app's persisted
            Redux keys.
          </SectionBody>
          <Smallest>
            Expected result: the MMKV probe writes and reads the same value on
            the worker runtime, and the txhistory proof fetches three worker-side
            pages for the selected wallet.
          </Smallest>
        </Card>

        <Card>
          <SectionTitle>Worker MMKV roundtrip</SectionTitle>
          <SectionBody>
            This probe passes an MMKV native host object into the worker
            runtime, writes a demo key there, reads it back on the same worker,
            and then verifies the value is visible on the RN runtime before
            cleaning it up.
          </SectionBody>
          <Button
            state={mmkvLoading ? 'loading' : undefined}
            disabled={mmkvLoading}
            onPress={handleRunMmkvProbe}
            accessibilityLabel="Run an MMKV write and read roundtrip on the worker runtime">
            Run worker MMKV roundtrip
          </Button>
        </Card>

        <Card>
          <SectionTitle>Select a wallet</SectionTitle>
          <MetaText>Eligible wallets found: {walletOptions.length}</MetaText>
          {walletOptions.length ? (
            walletOptions.map(wallet => {
              const isSelected =
                wallet.selectionId === selectedWallet?.selectionId;

              return (
                <WalletOption
                  key={wallet.selectionId}
                  $selected={isSelected}
                  onPress={() => {
                    setSelectedWalletId(wallet.selectionId);
                    setTxHistoryError(null);
                    setTxHistoryResult(null);
                  }}>
                  <WalletOptionTitle>{wallet.walletLabel}</WalletOptionTitle>
                  <WalletOptionSubTitle>
                    {wallet.walletSubLabel}
                  </WalletOptionSubTitle>
                  {wallet.tokenAddress ? (
                    <WalletOptionSubTitle>
                      Token: {truncateMiddle(wallet.tokenAddress, 8)}
                    </WalletOptionSubTitle>
                  ) : null}
                  {wallet.multisigContractAddress ? (
                    <WalletOptionSubTitle>
                      Contract:{' '}
                      {truncateMiddle(wallet.multisigContractAddress, 8)}
                    </WalletOptionSubTitle>
                  ) : null}
                  {isSelected ? (
                    <SelectedBadge>Selected wallet</SelectedBadge>
                  ) : null}
                </WalletOption>
              );
            })
          ) : (
            <SectionBody>
              No eligible wallet was found in app state. Import or create a BTC
              mainnet wallet first, then reopen this screen.
            </SectionBody>
          )}

          <Spacer />
          <Button
            state={txHistoryLoading ? 'loading' : undefined}
            disabled={!selectedWallet || txHistoryLoading}
            onPress={handleRunTxHistory}
            accessibilityLabel="Fetch multiple txhistory pages on the worker runtime">
            Fetch 3 txhistory pages via worker
          </Button>
        </Card>

        {mmkvLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>Writing and reading MMKV on the worker runtime...</LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {mmkvError ? (
          <Card>
            <SectionTitle>Worker MMKV probe failed</SectionTitle>
            <RawOutput selectable>{mmkvError}</RawOutput>
          </Card>
        ) : null}

        {mmkvResult ? (
          <Card>
            <SectionTitle>Worker MMKV result</SectionTitle>
            <MetaText>Worker runtime: {mmkvResult.workerRuntimeName}</MetaText>
            <MetaText>Storage id: {mmkvResult.storageId}</MetaText>
            <MetaText>Started at: {mmkvResult.startedAtIso}</MetaText>
            <MetaText>Completed at: {mmkvResult.completedAtIso}</MetaText>
            <MetaText>Duration: {mmkvResult.durationMs} ms</MetaText>
            <MetaText>Key: {mmkvResult.key}</MetaText>
            <MetaText>
              Worker read matches write:{' '}
              {mmkvResult.workerReadMatchesWrite ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              RN read matches write: {mmkvResult.rnReadMatchesWrite ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Worker contains key after write:{' '}
              {mmkvResult.workerContainsKeyAfterWrite ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              RN contains key after worker write:{' '}
              {mmkvResult.rnContainsKeyAfterWorkerWrite ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Cleanup removed key on RN:{' '}
              {mmkvResult.cleanupRemovedKeyOnRN ? 'yes' : 'no'}
            </MetaText>

            <Spacer />
            <SectionTitle>Raw JSON</SectionTitle>
            <RawOutput selectable>{JSON.stringify(mmkvResult, null, 2)}</RawOutput>
          </Card>
        ) : null}

        {txHistoryLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Signing txhistory requests on the worker runtime and fetching
                three pages...
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {txHistoryError ? (
          <Card>
            <SectionTitle>Worker txhistory request failed</SectionTitle>
            <RawOutput selectable>{txHistoryError}</RawOutput>
          </Card>
        ) : null}

        {txHistoryResult ? (
          <Card>
            <SectionTitle>Worker batch result</SectionTitle>
            <MetaText>Worker runtime: {txHistoryResult.workerRuntimeName}</MetaText>
            <MetaText>
              Session initialized: {txHistoryResult.session.initializedAtIso}
            </MetaText>
            <MetaText>Fetched at: {txHistoryResult.fetchedAtIso}</MetaText>
            <MetaText>
              Wallet: {txHistoryResult.session.wallet.walletName || 'Wallet'} (
              {txHistoryResult.session.wallet.walletId})
            </MetaText>
            <MetaText>
              Pages executed: {txHistoryResult.executedPageCount} /{' '}
              {txHistoryResult.requestedPageCount}
            </MetaText>
            <MetaText>
              Total transactions previewed:{' '}
              {txHistoryResult.totalTransactionsAcrossPages}
            </MetaText>
            <MetaText>
              Request sequence: {txHistoryResult.session.requestSequence}
            </MetaText>
            <MetaText>Total duration: {txHistoryResult.totalDurationMs} ms</MetaText>
            <MetaText>
              Stop reason:{' '}
              {txHistoryResult.stoppedEarly
                ? txHistoryResult.stopReason
                : 'max_pages_reached'}
            </MetaText>

            <Spacer />
            <SectionTitle>Per-page worker requests</SectionTitle>

            {txHistoryResult.pages.map((page, pageIndex) => {
              return (
                <React.Fragment key={page.requestPath}>
                  <TxPreviewRow>
                    <PageTitle>Page {page.pageIndex + 1}</PageTitle>
                    <TxPreviewMeta>Path: {page.requestPath}</TxPreviewMeta>
                    <TxPreviewMeta>
                      Status: {page.status} • Duration: {page.durationMs} ms •
                      Transactions: {page.txCount}
                    </TxPreviewMeta>
                    <TxPreviewMeta>
                      Signature preview: {page.signaturePreview}
                    </TxPreviewMeta>

                    {page.transactionsPreview.length ? (
                      page.transactionsPreview.map((tx, txIndex) => {
                        const txMeta = [
                          tx.amount != null ? `Amount: ${tx.amount}` : undefined,
                          tx.confirmations != null
                            ? `Confirmations: ${tx.confirmations}`
                            : undefined,
                          tx.addressTo
                            ? `To: ${truncateMiddle(tx.addressTo, 8)}`
                            : undefined,
                        ]
                          .filter(Boolean)
                          .join(' • ');

                        return (
                          <React.Fragment
                            key={`${page.requestPath}:${tx.txid || txIndex}`}>
                            <TxPreviewTitle>
                              {tx.action || 'Transaction'}
                              {tx.txid
                                ? ` • ${truncateMiddle(tx.txid, 8)}`
                                : ''}
                            </TxPreviewTitle>
                            {txMeta ? <TxPreviewMeta>{txMeta}</TxPreviewMeta> : null}
                          </React.Fragment>
                        );
                      })
                    ) : (
                      <TxPreviewMeta>No transactions returned for this page.</TxPreviewMeta>
                    )}
                  </TxPreviewRow>

                  {pageIndex < txHistoryResult.pages.length - 1 ? <Hr /> : null}
                </React.Fragment>
              );
            })}

            <Spacer />
            <SectionTitle>Raw JSON</SectionTitle>
            <RawOutput selectable>
              {JSON.stringify(txHistoryResult, null, 2)}
            </RawOutput>
          </Card>
        ) : null}
      </Content>
    </Container>
  );
};

export default WorkletsBundleModeDemo;
