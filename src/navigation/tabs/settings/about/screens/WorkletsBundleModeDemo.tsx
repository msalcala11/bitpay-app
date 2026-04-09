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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkerTxHistoryBatchResult | null>(null);
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
      setResult(null);
      return;
    }

    const hasSelectedWallet = walletOptions.some(
      wallet => wallet.selectionId === selectedWalletId,
    );

    if (!selectedWalletId || !hasSelectedWallet) {
      setSelectedWalletId(walletOptions[0].selectionId);
    }
  }, [selectedWalletId, walletOptions]);

  const handleRun = async () => {
    if (!selectedWallet) {
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const nextResult = await fetchWalletTxHistoryPagesOnWorker({
        wallet: selectedWallet,
        initialSkip: 0,
        pageSize: 10,
        pageCount: 3,
      });
      setResult(nextResult);
    } catch (err: unknown) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container>
      <Content contentContainerStyle={{paddingBottom: 32}}>
        <Card>
          <SectionTitle>Reduced Bundle Mode txhistory proof</SectionTitle>
          <SectionBody>
            This screen keeps the POC to one end-to-end path: select an
            eligible wallet, create or reuse a dedicated worker session, sign
            BWS `/v1/txhistory/` requests on that worker with transferred Nitro
            crypto handles, and fetch multiple pages without hopping back to
            the JS thread between requests.
          </SectionBody>
          <SectionBody>
            The broader smoke tests were useful while proving viability, but
            they are no longer needed to show the key result: signed worker
            requests succeed against the real txhistory endpoint.
          </SectionBody>
          <MetaText>Eligible wallets found: {walletOptions.length}</MetaText>
          <Smallest>
            Expected result: three worker-side txhistory requests complete for
            the selected wallet and return page summaries below.
          </Smallest>
        </Card>

        <Card>
          <SectionTitle>Select a wallet</SectionTitle>
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
                    setError(null);
                    setResult(null);
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
            state={loading ? 'loading' : undefined}
            disabled={!selectedWallet || loading}
            onPress={handleRun}
            accessibilityLabel="Fetch multiple txhistory pages on the worker runtime">
            Fetch 3 txhistory pages via worker
          </Button>
        </Card>

        {loading ? (
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

        {error ? (
          <Card>
            <SectionTitle>Worker request failed</SectionTitle>
            <RawOutput selectable>{error}</RawOutput>
          </Card>
        ) : null}

        {result ? (
          <Card>
            <SectionTitle>Worker batch result</SectionTitle>
            <MetaText>Worker runtime: {result.workerRuntimeName}</MetaText>
            <MetaText>Session initialized: {result.session.initializedAtIso}</MetaText>
            <MetaText>Fetched at: {result.fetchedAtIso}</MetaText>
            <MetaText>
              Wallet: {result.session.wallet.walletName || 'Wallet'} (
              {result.session.wallet.walletId})
            </MetaText>
            <MetaText>
              Pages executed: {result.executedPageCount} /{' '}
              {result.requestedPageCount}
            </MetaText>
            <MetaText>
              Total transactions previewed:{' '}
              {result.totalTransactionsAcrossPages}
            </MetaText>
            <MetaText>Request sequence: {result.session.requestSequence}</MetaText>
            <MetaText>Total duration: {result.totalDurationMs} ms</MetaText>
            <MetaText>
              Stop reason:{' '}
              {result.stoppedEarly ? result.stopReason : 'max_pages_reached'}
            </MetaText>

            <Spacer />
            <SectionTitle>Per-page worker requests</SectionTitle>

            {result.pages.map((page, pageIndex) => {
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

                  {pageIndex < result.pages.length - 1 ? <Hr /> : null}
                </React.Fragment>
              );
            })}

            <Spacer />
            <SectionTitle>Raw JSON</SectionTitle>
            <RawOutput selectable>{JSON.stringify(result, null, 2)}</RawOutput>
          </Card>
        ) : null}
      </Content>
    </Container>
  );
};

export default WorkletsBundleModeDemo;
