import BWC from 'bitcore-wallet-client';
import type {StoredWallet, Tx, WalletCredentials, WalletSummary} from './types';
import {formatAtomicAmount} from './format';

export type BwsConfig = {
  baseUrl: string; // e.g. "/bws/api" (proxied) or "https://bws.bitpay.com/bws/api"
  timeoutMs?: number;
};

export const DEFAULT_BWS_CONFIG: BwsConfig = {
  baseUrl: '/bws/api',
  timeoutMs: 100000,
};

export function normalizeCredentialsFromBackupText(
  text: string,
): WalletCredentials {
  const trimmed = text.trim();

  // Some exported .txt files contain instructions and the encrypted JSON between {...}
  const possibleJson = extractFirstCurlyBlock(trimmed) ?? trimmed;

  let parsed: any;
  try {
    parsed = JSON.parse(possibleJson);
  } catch {
    throw new Error(
      'Unable to parse file as JSON. Please upload a decrypted JSON backup (not an encrypted string).',
    );
  }

  // New format: { credentials: {...}, key?: {...}, addressBook?: {...} }
  if (parsed?.credentials) {
    return parsed.credentials;
  }

  // Sometimes the user may provide just the credentials object.
  if (parsed?.walletId || parsed?.walletName || parsed?.copayerId) {
    return parsed;
  }

  // SJCL encrypted backups look like {iv, salt, ct, ...}
  if (parsed?.ct && parsed?.iv) {
    throw new Error(
      'This looks like an encrypted BitPay backup. Export a decrypted JSON file (or add a decrypt step in the UI).',
    );
  }

  throw new Error('Backup format not recognized (missing credentials).');
}

export function isProbablySjclEncryptedPayload(text: string): boolean {
  const block = extractFirstCurlyBlock(text.trim()) ?? text.trim();
  try {
    const parsed = JSON.parse(block);
    return !!(parsed?.ct && parsed?.iv);
  } catch {
    return false;
  }
}

export function decryptSjclBackup(
  encryptedText: string,
  password: string,
): string {
  const block =
    extractFirstCurlyBlock(encryptedText.trim()) ?? encryptedText.trim();
  // @ts-ignore - BWC exposes sjcl
  return BWC.sjcl.decrypt(password, block);
}

function extractFirstCurlyBlock(s: string): string | null {
  const match = s.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

export function createBwcClient(
  credentials: WalletCredentials,
  cfg: BwsConfig,
): any {
  const client = new BWC({
    baseUrl: cfg.baseUrl,
    verbose: true,
    timeout: cfg.timeoutMs ?? DEFAULT_BWS_CONFIG.timeoutMs,
    transports: ['polling'],
  });

  const asString =
    typeof credentials === 'string' ? credentials : JSON.stringify(credentials);
  client.fromString(asString);

  return client;
}

export async function fetchWalletSummary(
  credentials: WalletCredentials,
  cfg: BwsConfig,
): Promise<WalletSummary> {
  const client = createBwcClient(credentials, cfg);
  const status = await getStatus(client);

  const walletName = String(
    status?.wallet?.name ||
      credentials?.walletName ||
      credentials?.walletId ||
      'Wallet',
  );

  const chain = String(
    credentials?.chain || credentials?.coin || '',
  ).toLowerCase();
  const network = String(credentials?.network || '').toLowerCase();

  const tokenAddress = credentials?.token?.address;

  // IMPORTANT:
  // Some BitPay-supported networks set `credentials.chain` to the network identifier (e.g. "base")
  // while the *asset* is still ETH. For rates and PnL calculations we want the asset symbol.
  // Prefer `credentials.coin` (asset) over `credentials.chain` (network) when available.
  const currencyAbbreviation = String(
    credentials?.token?.symbol || credentials?.coin || chain || '',
  ).toLowerCase();

  const balanceAtomic = String(status?.balance?.totalAmount ?? '0');
  const balanceFormatted = formatAtomicAmount(balanceAtomic, credentials);

  return {
    walletId: String(credentials?.walletId),
    walletName,
    chain,
    network,
    currencyAbbreviation,
    tokenAddress,
    balanceAtomic,
    balanceFormatted,
  };
}

export async function fetchAllTransactions(
  credentials: WalletCredentials,
  cfg: BwsConfig,
  opts?: {pageSize?: number; maxPages?: number},
): Promise<Tx[]> {
  const client = createBwcClient(credentials, cfg);
  const pageSize = opts?.pageSize ?? 200;
  const maxPages = opts?.maxPages ?? 200;

  const out: Tx[] = [];
  let skip = 0;
  for (let page = 0; page < maxPages; page++) {
    const pageTxs = await getTxHistory(client, {skip, limit: pageSize});
    if (pageTxs.length === 0) break;

    out.push(...pageTxs);
    if (pageTxs.length < pageSize) break;

    skip += pageSize;
  }

  // BWS usually returns newest-first, but enforce stable ordering.
  out.sort((a, b) => Number(a?.time ?? 0) - Number(b?.time ?? 0));
  return out;
}

export function upsertStoredWallet(
  wallets: StoredWallet[],
  newWallet: StoredWallet,
): StoredWallet[] {
  const existingIdx = wallets.findIndex(w => w.walletId === newWallet.walletId);
  if (existingIdx === -1) return [newWallet, ...wallets];
  const copy = wallets.slice();
  copy[existingIdx] = newWallet;
  return copy;
}

function getStatus(client: any): Promise<any> {
  const tokenAddress = client?.credentials?.token?.address ?? null;
  const multisigContractAddress =
    client?.credentials?.multisigEthInfo?.multisigContractAddress ?? null;
  const network = client?.credentials?.network;

  return new Promise((resolve, reject) => {
    client.getStatus(
      {
        twoStep: true,
        tokenAddress,
        multisigContractAddress,
        network,
      },
      (err: any, status: any) => {
        if (err) return reject(err);
        resolve(status);
      },
    );
  });
}

function getTxHistory(
  client: any,
  args: {skip: number; limit: number},
): Promise<Tx[]> {
  const tokenAddress = client?.credentials?.token?.address ?? '';
  const multisigContractAddress =
    client?.credentials?.multisigEthInfo?.multisigContractAddress ?? '';

  return new Promise((resolve, reject) => {
    client.getTxHistory(
      {
        skip: args.skip,
        limit: args.limit,
        tokenAddress,
        multisigContractAddress,
      },
      (err: any, txs: Tx[]) => {
        if (err) return reject(err);
        resolve(Array.isArray(txs) ? txs : []);
      },
    );
  });
}
