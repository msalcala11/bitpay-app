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
  fetchManyWalletTxHistoryPagesOnWorker,
  getRNRuntimeInfo,
  getWorkletsBundleModeRuntime,
  primeWalletTxHistoryWorkerSession,
  type WorkerTxHistorySigningMode,
  type WorkerTxHistoryBatchResult,
  type WorkerTxHistorySessionSummary,
  type WorkletsTxHistoryWalletSnapshot,
} from '../../../../../lib/workletsBundleModeDemo';
import {getOptionalBoxedBwsSigner} from '../../../../../lib/nitro/bwsSigner';
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

const RUNTIME_KIND_LABELS: Record<number, string> = {
  1: 'RN Runtime',
  2: 'UI Runtime',
  3: 'Worker Runtime',
};

const SIGNING_MODE_LABELS: Record<WorkerTxHistorySigningMode, string> = {
  rn_runtime: 'RN runtime signing fallback',
  worker_nitro_bws_signer: 'Worker Nitro BwsSigner',
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
  } catch (_) {
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

  if (!isMainnetNetwork(network)) {
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

const doesSessionMatchWallet = (
  session: WorkerTxHistorySessionSummary | null,
  wallet: DemoWalletOption | null,
) => {
  if (!session || !wallet) {
    return false;
  }

  return (
    session.wallet.walletId === wallet.walletId &&
    (session.wallet.tokenAddress || '') === (wallet.tokenAddress || '') &&
    (session.wallet.multisigContractAddress || '') ===
      (wallet.multisigContractAddress || '')
  );
};

const WorkletsBundleModeDemo = (_props: Props) => {
  const [priming, setPriming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<WorkerTxHistorySessionSummary | null>(
    null,
  );
  const [result, setResult] = useState<WorkerTxHistoryBatchResult | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

  const walletKeys = useAppSelector(({WALLET}) => WALLET?.keys || {});

  const rnRuntimeInfo = useMemo(() => getRNRuntimeInfo(), []);
  const workerRuntime = useMemo(() => getWorkletsBundleModeRuntime(), []);
  const boxedBwsSigner = useMemo(() => getOptionalBoxedBwsSigner(), []);
  const hasWorkerNitroBwsSigner = !!boxedBwsSigner;

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
      setSession(null);
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

  const sessionMatchesSelectedWallet = useMemo(() => {
    return doesSessionMatchWallet(session, selectedWallet);
  }, [selectedWallet, session]);

  const primeSelectedWalletOnWorker = async () => {
    if (!selectedWallet) {
      return null;
    }

    setPriming(true);
    setSessionError(null);
    setError(null);
    setResult(null);

    try {
      const nextSession = await primeWalletTxHistoryWorkerSession(selectedWallet);
      setSession(nextSession);
      return nextSession;
    } catch (err: unknown) {
      const nextError = toErrorMessage(err);
      setSession(null);
      setSessionError(nextError);
      return null;
    } finally {
      setPriming(false);
    }
  };

  const handleFetch = async () => {
    if (!selectedWallet) {
      return;
    }

    setLoading(true);
    setError(null);
    setSessionError(null);
    setResult(null);

    try {
      let activeSession = session;
      if (!doesSessionMatchWallet(activeSession, selectedWallet)) {
        activeSession = await primeWalletTxHistoryWorkerSession(selectedWallet);
        setSession(activeSession);
      }

      if (!activeSession) {
        throw new Error('Unable to initialize the worker wallet session.');
      }

      const nextResult = await fetchManyWalletTxHistoryPagesOnWorker({
        wallet: selectedWallet,
        boxedBwsSigner,
        initialSkip: 0,
        pageSize: 10,
        pageCount: 3,
      });

      setSession(nextResult.session);
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
          <SectionTitle>Bundle Mode txhistory worker-session demo</SectionTitle>
          <SectionBody>
            This iteration primes the selected wallet into a dedicated Worklets
            worker once, then that worker executes multiple paged
            /v1/txhistory/ requests. If a native `BwsSigner` Hybrid Object is
            registered, the worker signs requests with Nitro directly;
            otherwise the demo falls back to RN-side signing before dispatch.
          </SectionBody>
          <MetaText>RN runtime kind: {RUNTIME_KIND_LABELS[rnRuntimeInfo.runtimeKind]} ({rnRuntimeInfo.runtimeKind})</MetaText>
          <MetaText>
            Worker runtime: {workerRuntime.name} (id: {workerRuntime.runtimeId})
          </MetaText>
          <MetaText>
            Worker Nitro BwsSigner registered:{' '}
            {hasWorkerNitroBwsSigner ? 'yes' : 'no'}
          </MetaText>
          <MetaText>
            Active signing path:{' '}
            {hasWorkerNitroBwsSigner
              ? SIGNING_MODE_LABELS.worker_nitro_bws_signer
              : SIGNING_MODE_LABELS.rn_runtime}
          </MetaText>
          <MetaText>Eligible wallets found: {walletOptions.length}</MetaText>
          <Smallest>
            Expected result after a successful run: the worker session should be
            primed for the selected wallet and the page results should show 3
            Worker Runtime fetches using request paths derived from the worker
            session sequence, with the result reporting which signing path was
            actually used.
          </Smallest>
        </Card>

        <Card>
          <SectionTitle>Select a wallet</SectionTitle>
          {walletOptions.length ? (
            walletOptions.map(wallet => {
              const isSelected = wallet.selectionId === selectedWallet?.selectionId;
              return (
                <WalletOption
                  key={wallet.selectionId}
                  $selected={isSelected}
                  onPress={() => {
                    setSelectedWalletId(wallet.selectionId);
                    setSessionError(null);
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
                      Contract: {truncateMiddle(
                        wallet.multisigContractAddress,
                        8,
                      )}
                    </WalletOptionSubTitle>
                  ) : null}
                  {isSelected ? <SelectedBadge>Selected wallet</SelectedBadge> : null}
                </WalletOption>
              );
            })
          ) : (
            <SectionBody>
              No eligible wallet was found in the app state. Import or create a
              wallet first, then reopen this screen.
            </SectionBody>
          )}

          <Spacer />
          <Button
            state={priming ? 'loading' : undefined}
            disabled={!selectedWallet || priming || loading}
            onPress={primeSelectedWalletOnWorker}
            accessibilityLabel="Prime worker session with the selected wallet">
            Prime selected wallet on worker runtime
          </Button>

          <Spacer />
          <Button
            state={loading ? 'loading' : undefined}
            disabled={!selectedWallet || priming || loading}
            onPress={handleFetch}
            accessibilityLabel="Fetch multiple txhistory pages with worker runtime fetches">
            Fetch 3 txhistory pages via worker
          </Button>
        </Card>

        {priming ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Initializing the worker runtime with the selected wallet&apos;s
                txhistory request context…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {loading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                {hasWorkerNitroBwsSigner
                  ? 'Running repeated worker-side txhistory fetches with Nitro worker signing…'
                  : 'Running repeated worker-side txhistory fetches with RN-side request signing…'}
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {sessionError ? (
          <Card>
            <SectionTitle>Worker session error</SectionTitle>
            <RawOutput selectable>{sessionError}</RawOutput>
          </Card>
        ) : null}

        {session ? (
          <Card>
            <SectionTitle>Worker session</SectionTitle>
            <MetaText>
              Session wallet matches selection:{' '}
              {sessionMatchesSelectedWallet ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Worker runtime kind:{' '}
              {RUNTIME_KIND_LABELS[session.runtimeKind] || 'Unknown'} (
              {session.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed worker runtime: {session.isWorkerRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Initialized at: {session.initializedAtIso}</MetaText>
            <MetaText>Worker request sequence: {session.requestSequence}</MetaText>
            <MetaText>
              Stored request pubkey:{' '}
              {truncateMiddle(session.wallet.requestPubKey, 8)}
            </MetaText>
            <MetaText>
              Derived request pubkey:{' '}
              {truncateMiddle(session.wallet.derivedRequestPubKey, 8)}
            </MetaText>
            <MetaText>
              Request pubkey matches derived:{' '}
              {session.wallet.requestPubKeyMatchesDerived === undefined
                ? 'not provided'
                : session.wallet.requestPubKeyMatchesDerived
                  ? 'yes'
                  : 'no'}
            </MetaText>
            <MetaText>
              Wallet: {session.wallet.walletName || session.wallet.walletId}
            </MetaText>
            <MetaText>Key: {session.wallet.keyName || 'n/a'}</MetaText>
            <MetaText>
              Chain/network: {session.wallet.chain || 'n/a'} /{' '}
              {session.wallet.network || 'n/a'}
            </MetaText>
            <MetaText>
              Request base path: {session.requestContext.basePath}
            </MetaText>
            <MetaText>
              Token wallet: {session.wallet.isTokenWallet ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Multisig contract wallet:{' '}
              {session.wallet.isMultisigContractWallet ? 'yes' : 'no'}
            </MetaText>
            {session.requestContext.tokenAddress ? (
              <MetaText>
                Token address:{' '}
                {truncateMiddle(session.requestContext.tokenAddress, 8)}
              </MetaText>
            ) : null}
            {session.requestContext.multisigContractAddress ? (
              <MetaText>
                Multisig contract:{' '}
                {truncateMiddle(
                  session.requestContext.multisigContractAddress,
                  8,
                )}
              </MetaText>
            ) : null}
            <Spacer />
            <SectionTitle>Session JSON</SectionTitle>
            <RawOutput selectable>{JSON.stringify(session, null, 2)}</RawOutput>
          </Card>
        ) : null}

        {error ? (
          <Card>
            <SectionTitle>Request failed</SectionTitle>
            <RawOutput selectable>{error}</RawOutput>
          </Card>
        ) : null}

        {result ? (
          <Card>
            <SectionTitle>Worker batch result</SectionTitle>
            <MetaText>
              Worker runtime kind:{' '}
              {RUNTIME_KIND_LABELS[result.runtimeKind] || 'Unknown'} (
              {result.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed worker runtime: {result.isWorkerRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Signing mode:{' '}
              {SIGNING_MODE_LABELS[result.signingMode] || result.signingMode}
            </MetaText>
            <MetaText>Total duration: {result.totalDurationMs} ms</MetaText>
            <MetaText>Fetched at: {result.fetchedAtIso}</MetaText>
            <MetaText>
              Requested pages: {result.requestedPageCount} / executed pages:{' '}
              {result.executedPageCount}
            </MetaText>
            <MetaText>Page size: {result.pageSize}</MetaText>
            <MetaText>Total tx count: {result.totalTransactionsAcrossPages}</MetaText>
            <MetaText>
              Stopped early: {result.stoppedEarly ? 'yes' : 'no'} ({result.stopReason})
            </MetaText>
            <MetaText>
              Worker request sequence after batch:{' '}
              {result.session.requestSequence}
            </MetaText>
            <Spacer />
            <SectionTitle>Per-page worker requests</SectionTitle>
            {result.pages.map((page, index) => {
              return (
                <React.Fragment key={`${page.requestPath}-${index}`}>
                  <TxPreviewRow>
                    <PageTitle>
                      Page {page.pageIndex + 1} • skip {page.skip} • limit{' '}
                      {page.limit}
                    </PageTitle>
                    <TxPreviewMeta>HTTP status: {page.status}</TxPreviewMeta>
                    <TxPreviewMeta>Duration: {page.durationMs} ms</TxPreviewMeta>
                    <TxPreviewMeta>Fetched at: {page.fetchedAtIso}</TxPreviewMeta>
                    <TxPreviewMeta>Request path: {page.requestPath}</TxPreviewMeta>
                    <TxPreviewMeta>
                      Signature preview: {page.signaturePreview}
                    </TxPreviewMeta>
                    <TxPreviewMeta>Returned tx count: {page.txCount}</TxPreviewMeta>

                    {page.transactionsPreview.length ? (
                      page.transactionsPreview.map((tx, txIndex) => (
                        <React.Fragment key={`${tx.txid || 'tx'}-${txIndex}`}>
                          <Spacer />
                          <TxPreviewTitle>
                            {tx.action || 'unknown'} • {truncateMiddle(tx.txid, 10)}
                          </TxPreviewTitle>
                          <TxPreviewMeta>
                            confirmations: {tx.confirmations ?? 'n/a'}
                          </TxPreviewMeta>
                          <TxPreviewMeta>
                            amount: {String(tx.amount ?? 'n/a')}
                          </TxPreviewMeta>
                          <TxPreviewMeta>
                            fees: {String(tx.fees ?? 'n/a')}
                          </TxPreviewMeta>
                          <TxPreviewMeta>
                            addressTo: {truncateMiddle(tx.addressTo, 10)}
                          </TxPreviewMeta>
                          <TxPreviewMeta>
                            time: {String(tx.time ?? 'n/a')}
                          </TxPreviewMeta>
                        </React.Fragment>
                      ))
                    ) : (
                      <TxPreviewMeta>
                        No transactions were returned for this request.
                      </TxPreviewMeta>
                    )}
                  </TxPreviewRow>
                  {index < result.pages.length - 1 ? <Hr /> : null}
                </React.Fragment>
              );
            })}

            <Spacer />
            <SectionTitle>Raw payload</SectionTitle>
            <RawOutput selectable>{JSON.stringify(result, null, 2)}</RawOutput>
          </Card>
        ) : null}
      </Content>
    </Container>
  );
};

export default WorkletsBundleModeDemo;
