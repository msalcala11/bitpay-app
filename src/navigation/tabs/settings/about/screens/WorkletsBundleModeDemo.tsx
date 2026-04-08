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
  runBigIntSmokeTestOnWorker,
  runRNNitroBwsSigningControlTest,
  runTransferredNitroBwsSigningSmokeTestOnWorker,
  runQuickCryptoHashSmokeTestOnWorker,
  runTransferredNitroHashSmokeTestOnWorker,
  type WorkerBigIntSmokeTestResult,
  type RNNitroBwsSigningSmokeTestResult,
  type WorkerTransferredNitroBwsSigningSmokeTestResult,
  type WorkerQuickCryptoHashSmokeTestResult,
  type WorkerTransferredNitroHashSmokeTestResult,
  type WorkerTxHistoryBatchResult,
  type WorkerTxHistorySessionSummary,
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

const RUNTIME_KIND_LABELS: Record<number, string> = {
  1: 'RN Runtime',
  2: 'UI Runtime',
  3: 'Worker Runtime',
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
  const [bigIntLoading, setBigIntLoading] = useState(false);
  const [quickCryptoLoading, setQuickCryptoLoading] = useState(false);
  const [transferredHashLoading, setTransferredHashLoading] = useState(false);
  const [rnNitroSigningLoading, setRNNitroSigningLoading] = useState(false);
  const [transferredSigningLoading, setTransferredSigningLoading] =
    useState(false);
  const [loading, setLoading] = useState(false);
  const [bigIntError, setBigIntError] = useState<string | null>(null);
  const [bigIntResult, setBigIntResult] =
    useState<WorkerBigIntSmokeTestResult | null>(null);
  const [quickCryptoError, setQuickCryptoError] = useState<string | null>(null);
  const [quickCryptoResult, setQuickCryptoResult] =
    useState<WorkerQuickCryptoHashSmokeTestResult | null>(null);
  const [transferredHashError, setTransferredHashError] = useState<
    string | null
  >(null);
  const [transferredHashResult, setTransferredHashResult] =
    useState<WorkerTransferredNitroHashSmokeTestResult | null>(null);
  const [rnNitroSigningError, setRNNitroSigningError] = useState<string | null>(
    null,
  );
  const [rnNitroSigningResult, setRNNitroSigningResult] =
    useState<RNNitroBwsSigningSmokeTestResult | null>(null);
  const [transferredSigningError, setTransferredSigningError] = useState<
    string | null
  >(null);
  const [transferredSigningResult, setTransferredSigningResult] =
    useState<WorkerTransferredNitroBwsSigningSmokeTestResult | null>(null);
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

  const handleQuickCryptoSmokeTest = async () => {
    setQuickCryptoLoading(true);
    setQuickCryptoError(null);
    setQuickCryptoResult(null);

    try {
      const nextResult = await runQuickCryptoHashSmokeTestOnWorker();
      setQuickCryptoResult(nextResult);
    } catch (err: unknown) {
      setQuickCryptoError(toErrorMessage(err));
    } finally {
      setQuickCryptoLoading(false);
    }
  };

  const handleBigIntSmokeTest = async () => {
    setBigIntLoading(true);
    setBigIntError(null);
    setBigIntResult(null);

    try {
      const nextResult = await runBigIntSmokeTestOnWorker();
      setBigIntResult(nextResult);
    } catch (err: unknown) {
      setBigIntError(toErrorMessage(err));
    } finally {
      setBigIntLoading(false);
    }
  };

  const handleTransferredNitroHashSmokeTest = async () => {
    setTransferredHashLoading(true);
    setTransferredHashError(null);
    setTransferredHashResult(null);

    try {
      const nextResult = await runTransferredNitroHashSmokeTestOnWorker();
      setTransferredHashResult(nextResult);
    } catch (err: unknown) {
      setTransferredHashError(toErrorMessage(err));
    } finally {
      setTransferredHashLoading(false);
    }
  };

  const handleTransferredNitroSigningSmokeTest = async () => {
    if (!selectedWallet) {
      return;
    }

    setTransferredSigningLoading(true);
    setTransferredSigningError(null);
    setTransferredSigningResult(null);

    try {
      const nextResult = await runTransferredNitroBwsSigningSmokeTestOnWorker(
        selectedWallet,
      );
      setTransferredSigningResult(nextResult);
    } catch (err: unknown) {
      setTransferredSigningError(toErrorMessage(err));
    } finally {
      setTransferredSigningLoading(false);
    }
  };

  const handleRNNitroSigningControlTest = async () => {
    if (!selectedWallet) {
      return;
    }

    setRNNitroSigningLoading(true);
    setRNNitroSigningError(null);
    setRNNitroSigningResult(null);

    try {
      const nextResult = await runRNNitroBwsSigningControlTest(selectedWallet);
      setRNNitroSigningResult(nextResult);
    } catch (err: unknown) {
      setRNNitroSigningError(toErrorMessage(err));
    } finally {
      setRNNitroSigningLoading(false);
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
            Before trying worklet-side signing, this screen can run a very
            small runtime-capability probe for `BigInt`, then a QuickCrypto
            smoke test in two variants: first by importing
            `react-native-quick-crypto` directly inside the worker runtime,
            then by creating the underlying Nitro `Hash` Hybrid Object on RN
            and passing that object into the worker. It also includes a
            transferred Nitro signing proof and an RN-only Nitro signing
            control for a BWS-style `get|path|{}` message using the selected
            wallet&apos;s request key.
          </SectionBody>
          <SectionBody>
            This iteration primes the selected wallet into a dedicated Worklets
            worker once, then that worker executes multiple paged
            /v1/txhistory/ requests while signing each request path inside the
            worker via transferred Nitro crypto handles that were created on
            RN. That keeps signing, fetch, and response parsing off the JS
            thread while avoiding direct Nitro module imports inside the
            Worklet runtime.
          </SectionBody>
          <MetaText>RN runtime kind: {RUNTIME_KIND_LABELS[rnRuntimeInfo.runtimeKind]} ({rnRuntimeInfo.runtimeKind})</MetaText>
          <MetaText>
            Worker runtime: {workerRuntime.name} (id: {workerRuntime.runtimeId})
          </MetaText>
          <MetaText>Eligible wallets found: {walletOptions.length}</MetaText>
          <Smallest>
            Expected result after a successful run: the worker session should be
            primed for the selected wallet and the page results should show 3
            Worker Runtime fetches using request paths derived from the worker
            session sequence.
          </Smallest>
        </Card>

        <Card>
          <SectionTitle>Worker BigInt smoke test</SectionTitle>
          <SectionBody>
            This verifies that the worker runtime exposes the global `BigInt`
            constructor and can perform integer math beyond
            `Number.MAX_SAFE_INTEGER`.
          </SectionBody>
          <Button
            state={bigIntLoading ? 'loading' : undefined}
            disabled={
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              transferredSigningLoading
            }
            onPress={handleBigIntSmokeTest}
            accessibilityLabel="Run the worker BigInt smoke test">
            Run worker BigInt smoke test
          </Button>
        </Card>

        <Card>
          <SectionTitle>QuickCrypto worker smoke test</SectionTitle>
          <SectionBody>
            This uses the direct package-root import path inside the worker
            runtime and attempts a fixed SHA-256 digest. It is meant to answer
            one narrow question: does `react-native-quick-crypto` import and
            run a sync hash successfully in Bundle Mode on this branch?
          </SectionBody>
          <Button
            state={quickCryptoLoading ? 'loading' : undefined}
            disabled={
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              rnNitroSigningLoading ||
              transferredSigningLoading
            }
            onPress={handleQuickCryptoSmokeTest}
            accessibilityLabel="Run the QuickCrypto worker smoke test">
            Run QuickCrypto SHA-256 smoke test
          </Button>
        </Card>

        <Card>
          <SectionTitle>Transferred Nitro Hash smoke test</SectionTitle>
          <SectionBody>
            This creates QuickCrypto&apos;s underlying Nitro `Hash` Hybrid
            Object on the RN runtime, passes that object across runtimes, and
            calls its hash methods from inside the worker runtime.
          </SectionBody>
          <Button
            state={transferredHashLoading ? 'loading' : undefined}
            disabled={
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              rnNitroSigningLoading ||
              transferredSigningLoading
            }
            onPress={handleTransferredNitroHashSmokeTest}
            accessibilityLabel="Run the transferred Nitro Hash worker smoke test">
            Run transferred Nitro Hash smoke test
          </Button>
        </Card>

        <Card>
          <SectionTitle>RN Nitro BWS signing control</SectionTitle>
          <SectionBody>
            This runs the same Nitro `Hash`, `SignHandle`, and
            `KeyObjectHandle` signing flow entirely on the RN runtime with no
            worklet hop, so we can tell whether a signature mismatch is caused
            by runtime transfer or by Nitro/OpenSSL signing semantics.
          </SectionBody>
          <Button
            state={rnNitroSigningLoading ? 'loading' : undefined}
            disabled={
              !selectedWallet ||
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              rnNitroSigningLoading ||
              transferredSigningLoading
            }
            onPress={handleRNNitroSigningControlTest}
            accessibilityLabel="Run the RN Nitro BWS signing control test">
            Run RN Nitro BWS signing control
          </Button>
        </Card>

        <Card>
          <SectionTitle>Transferred Nitro BWS signing smoke test</SectionTitle>
          <SectionBody>
            This creates Nitro `Hash`, `SignHandle`, and `KeyObjectHandle`
            objects on the RN runtime for the selected wallet&apos;s request
            key, transfers those handles into the worker runtime, and signs a
            fixed BWS-style request message there. The result then comes back
            to RN for bitcore verification.
          </SectionBody>
          <Button
            state={transferredSigningLoading ? 'loading' : undefined}
            disabled={
              !selectedWallet ||
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              rnNitroSigningLoading ||
              transferredSigningLoading
            }
            onPress={handleTransferredNitroSigningSmokeTest}
            accessibilityLabel="Run the transferred Nitro BWS signing smoke test">
            Run transferred Nitro BWS signing smoke test
          </Button>
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
            disabled={
              !selectedWallet ||
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              rnNitroSigningLoading ||
              transferredSigningLoading
            }
            onPress={primeSelectedWalletOnWorker}
            accessibilityLabel="Prime worker session with the selected wallet">
            Prime selected wallet on worker runtime
          </Button>

          <Spacer />
          <Button
            state={loading ? 'loading' : undefined}
            disabled={
              !selectedWallet ||
              priming ||
              loading ||
              bigIntLoading ||
              quickCryptoLoading ||
              transferredHashLoading ||
              rnNitroSigningLoading ||
              transferredSigningLoading
            }
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

        {bigIntLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Checking whether the worker runtime supports `BigInt`
                arithmetic…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {quickCryptoLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Importing `react-native-quick-crypto` inside the worker runtime
                and running a sync SHA-256 digest…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {transferredHashLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Creating a Nitro `Hash` Hybrid Object on RN and exercising it
                from inside the worker runtime…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {rnNitroSigningLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Running the Nitro BWS signing control fully on the RN runtime…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {transferredSigningLoading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Creating Nitro crypto handles on RN, transferring them into the
                worker runtime, and signing a BWS-style request message there…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {loading ? (
          <Card>
            <StatusRow>
              <ActivityIndicator />
              <LoadingText>
                Running repeated worker-side txhistory fetches with transferred
                Nitro request signing…
              </LoadingText>
            </StatusRow>
          </Card>
        ) : null}

        {bigIntError ? (
          <Card>
            <SectionTitle>Worker BigInt smoke test failed</SectionTitle>
            <RawOutput selectable>{bigIntError}</RawOutput>
          </Card>
        ) : null}

        {bigIntResult ? (
          <Card>
            <SectionTitle>Worker BigInt smoke test</SectionTitle>
            <MetaText>
              Worker runtime kind:{' '}
              {RUNTIME_KIND_LABELS[bigIntResult.runtimeKind] || 'Unknown'} (
              {bigIntResult.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed worker runtime:{' '}
              {bigIntResult.isWorkerRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Executed at: {bigIntResult.executedAtIso}</MetaText>
            <MetaText>
              Global `BigInt` available:{' '}
              {bigIntResult.hasBigIntGlobal ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Result type: {bigIntResult.bigintType}</MetaText>
            <MetaText>Left operand: {bigIntResult.leftOperand}</MetaText>
            <MetaText>Right operand: {bigIntResult.rightOperand}</MetaText>
            <MetaText>Computed sum: {bigIntResult.sumDecimal}</MetaText>
            <MetaText>
              Sum matches expected:{' '}
              {bigIntResult.sumMatchesExpected ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Square in hex: {bigIntResult.productHex}</MetaText>
            <MetaText>
              Square matches expected:{' '}
              {bigIntResult.productMatchesExpected ? 'yes' : 'no'}
            </MetaText>
            <Spacer />
            <SectionTitle>BigInt JSON</SectionTitle>
            <RawOutput selectable>
              {JSON.stringify(bigIntResult, null, 2)}
            </RawOutput>
          </Card>
        ) : null}

        {quickCryptoError ? (
          <Card>
            <SectionTitle>QuickCrypto smoke test failed</SectionTitle>
            <RawOutput selectable>{quickCryptoError}</RawOutput>
          </Card>
        ) : null}

        {quickCryptoResult ? (
          <Card>
            <SectionTitle>QuickCrypto smoke test</SectionTitle>
            <MetaText>
              Worker runtime kind:{' '}
              {RUNTIME_KIND_LABELS[quickCryptoResult.runtimeKind] || 'Unknown'} (
              {quickCryptoResult.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed worker runtime:{' '}
              {quickCryptoResult.isWorkerRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Executed at: {quickCryptoResult.executedAtIso}</MetaText>
            <MetaText>
              `createHash` available:{' '}
              {quickCryptoResult.hasCreateHash ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              `install` export available:{' '}
              {quickCryptoResult.hasInstall ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              `setImmediate` available:{' '}
              {quickCryptoResult.hasSetImmediate ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              `process.nextTick` available:{' '}
              {quickCryptoResult.hasProcessNextTick ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Digest matches expected:{' '}
              {quickCryptoResult.matchesExpected ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Input: {quickCryptoResult.input}</MetaText>
            <MetaText>Digest: {quickCryptoResult.digestHex}</MetaText>
            <MetaText>
              Expected: {quickCryptoResult.expectedDigestHex}
            </MetaText>
            <MetaText>Module kind: {quickCryptoResult.moduleKind}</MetaText>
            <MetaText>
              Exported keys preview:{' '}
              {quickCryptoResult.exportedKeysPreview.join(', ') || 'none'}
            </MetaText>
            <Spacer />
            <SectionTitle>QuickCrypto JSON</SectionTitle>
            <RawOutput selectable>
              {JSON.stringify(quickCryptoResult, null, 2)}
            </RawOutput>
          </Card>
        ) : null}

        {transferredHashError ? (
          <Card>
            <SectionTitle>Transferred Nitro Hash smoke test failed</SectionTitle>
            <RawOutput selectable>{transferredHashError}</RawOutput>
          </Card>
        ) : null}

        {transferredHashResult ? (
          <Card>
            <SectionTitle>Transferred Nitro Hash smoke test</SectionTitle>
            <MetaText>
              Worker runtime kind:{' '}
              {RUNTIME_KIND_LABELS[transferredHashResult.runtimeKind] ||
                'Unknown'}{' '}
              ({transferredHashResult.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed worker runtime:{' '}
              {transferredHashResult.isWorkerRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Executed at: {transferredHashResult.executedAtIso}
            </MetaText>
            <MetaText>
              `createHash` available:{' '}
              {transferredHashResult.hasCreateHash ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              `update` available:{' '}
              {transferredHashResult.hasUpdate ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              `digest` available:{' '}
              {transferredHashResult.hasDigest ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              `getSupportedHashAlgorithms` available:{' '}
              {transferredHashResult.hasGetSupportedHashAlgorithms
                ? 'yes'
                : 'no'}
            </MetaText>
            <MetaText>
              `getOpenSSLVersion` available:{' '}
              {transferredHashResult.hasGetOpenSSLVersion ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Supports `sha256`:{' '}
              {transferredHashResult.supportsSha256 ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Digest matches expected:{' '}
              {transferredHashResult.matchesExpected ? 'yes' : 'no'}
            </MetaText>
            <MetaText>Input: {transferredHashResult.input}</MetaText>
            <MetaText>Digest: {transferredHashResult.digestHex}</MetaText>
            <MetaText>
              Expected: {transferredHashResult.expectedDigestHex}
            </MetaText>
            <MetaText>
              OpenSSL version: {transferredHashResult.opensslVersion || 'n/a'}
            </MetaText>
            <Spacer />
            <SectionTitle>Transferred Hash JSON</SectionTitle>
            <RawOutput selectable>
              {JSON.stringify(transferredHashResult, null, 2)}
            </RawOutput>
          </Card>
        ) : null}

        {rnNitroSigningError ? (
          <Card>
            <SectionTitle>RN Nitro BWS signing control failed</SectionTitle>
            <RawOutput selectable>{rnNitroSigningError}</RawOutput>
          </Card>
        ) : null}

        {rnNitroSigningResult ? (
          <Card>
            <SectionTitle>RN Nitro BWS signing control</SectionTitle>
            <MetaText>
              RN runtime kind:{' '}
              {RUNTIME_KIND_LABELS[rnNitroSigningResult.runtimeKind] ||
                'Unknown'}{' '}
              ({rnNitroSigningResult.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed RN runtime:{' '}
              {rnNitroSigningResult.isRNRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Executed at: {rnNitroSigningResult.executedAtIso}
            </MetaText>
            <MetaText>
              Request method/path:{' '}
              {rnNitroSigningResult.requestMethod.toUpperCase()}{' '}
              {rnNitroSigningResult.requestPath}
            </MetaText>
            <MetaText>
              Stored request pubkey:{' '}
              {truncateMiddle(rnNitroSigningResult.requestPubKey, 8)}
            </MetaText>
            <MetaText>
              Derived request pubkey:{' '}
              {truncateMiddle(rnNitroSigningResult.derivedRequestPubKey, 8)}
            </MetaText>
            <MetaText>
              Request pubkey matches derived:{' '}
              {rnNitroSigningResult.requestPubKeyMatchesDerived === undefined
                ? 'not provided'
                : rnNitroSigningResult.requestPubKeyMatchesDerived
                  ? 'yes'
                  : 'no'}
            </MetaText>
            <MetaText>
              Nitro digests match bitcore:{' '}
              {rnNitroSigningResult.nitroDigestsMatchBitcore ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Bitcore verifies RN Nitro signature:{' '}
              {rnNitroSigningResult.bitcoreVerifiedNitroSignature
                ? 'yes'
                : 'no'}
            </MetaText>
            <MetaText>
              Bitcore verifies its own signature:{' '}
              {rnNitroSigningResult.bitcoreVerifiedBitcoreSignature
                ? 'yes'
                : 'no'}
            </MetaText>
            <MetaText>
              Exact DER match with bitcore:{' '}
              {rnNitroSigningResult.exactSignatureMatch ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              OpenSSL version: {rnNitroSigningResult.opensslVersion || 'n/a'}
            </MetaText>
            <MetaText>
              First SHA-256: {rnNitroSigningResult.sha256OnceHex}
            </MetaText>
            <MetaText>
              Double SHA-256: {rnNitroSigningResult.sha256TwiceHex}
            </MetaText>
            <MetaText>
              Reversed digest: {rnNitroSigningResult.reversedDigestHex}
            </MetaText>
            <MetaText>
              RN Nitro signature: {rnNitroSigningResult.nitroSignatureHex}
            </MetaText>
            <MetaText>
              RN bitcore signature: {rnNitroSigningResult.bitcoreSignatureHex}
            </MetaText>
            <Spacer />
            <SectionTitle>Signing message</SectionTitle>
            <RawOutput selectable>
              {rnNitroSigningResult.signingMessage}
            </RawOutput>
            <Spacer />
            <SectionTitle>RN Nitro signing JSON</SectionTitle>
            <RawOutput selectable>
              {JSON.stringify(rnNitroSigningResult, null, 2)}
            </RawOutput>
          </Card>
        ) : null}

        {transferredSigningError ? (
          <Card>
            <SectionTitle>
              Transferred Nitro BWS signing smoke test failed
            </SectionTitle>
            <RawOutput selectable>{transferredSigningError}</RawOutput>
          </Card>
        ) : null}

        {transferredSigningResult ? (
          <Card>
            <SectionTitle>Transferred Nitro BWS signing smoke test</SectionTitle>
            <MetaText>
              Worker runtime kind:{' '}
              {RUNTIME_KIND_LABELS[transferredSigningResult.runtimeKind] ||
                'Unknown'}{' '}
              ({transferredSigningResult.runtimeKind})
            </MetaText>
            <MetaText>
              Confirmed worker runtime:{' '}
              {transferredSigningResult.isWorkerRuntime ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              Executed at: {transferredSigningResult.executedAtIso}
            </MetaText>
            <MetaText>
              Request method/path: {transferredSigningResult.requestMethod.toUpperCase()}{' '}
              {transferredSigningResult.requestPath}
            </MetaText>
            <MetaText>
              Stored request pubkey:{' '}
              {truncateMiddle(transferredSigningResult.requestPubKey, 8)}
            </MetaText>
            <MetaText>
              Derived request pubkey:{' '}
              {truncateMiddle(
                transferredSigningResult.derivedRequestPubKey,
                8,
              )}
            </MetaText>
            <MetaText>
              Request pubkey matches derived:{' '}
              {transferredSigningResult.requestPubKeyMatchesDerived ===
              undefined
                ? 'not provided'
                : transferredSigningResult.requestPubKeyMatchesDerived
                  ? 'yes'
                  : 'no'}
            </MetaText>
            <MetaText>
              Bitcore verifies worker Nitro signature:{' '}
              {transferredSigningResult.bitcoreVerifiedNitroSignature
                ? 'yes'
                : 'no'}
            </MetaText>
            <MetaText>
              Bitcore verifies its own signature:{' '}
              {transferredSigningResult.bitcoreVerifiedBitcoreSignature
                ? 'yes'
                : 'no'}
            </MetaText>
            <MetaText>
              Exact DER match with bitcore:{' '}
              {transferredSigningResult.exactSignatureMatch ? 'yes' : 'no'}
            </MetaText>
            <MetaText>
              OpenSSL version: {transferredSigningResult.opensslVersion || 'n/a'}
            </MetaText>
            <MetaText>
              First SHA-256: {transferredSigningResult.sha256OnceHex}
            </MetaText>
            <MetaText>
              Double SHA-256: {transferredSigningResult.sha256TwiceHex}
            </MetaText>
            <MetaText>
              Reversed digest: {transferredSigningResult.reversedDigestHex}
            </MetaText>
            <MetaText>
              Worker Nitro signature: {transferredSigningResult.nitroSignatureHex}
            </MetaText>
            <MetaText>
              RN bitcore signature: {transferredSigningResult.bitcoreSignatureHex}
            </MetaText>
            <Spacer />
            <SectionTitle>Signing message</SectionTitle>
            <RawOutput selectable>
              {transferredSigningResult.signingMessage}
            </RawOutput>
            <Spacer />
            <SectionTitle>Transferred signing JSON</SectionTitle>
            <RawOutput selectable>
              {JSON.stringify(transferredSigningResult, null, 2)}
            </RawOutput>
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
