import type {Wallet} from '../../store/wallet/wallet.models';

export type ParsedAssetId = {
  assetId: string;
  chain: string;
  coin: string;
  tokenAddress?: string;
};

/**
 * Canonical per-asset identifier used throughout portfolio + assets list.
 *
 * Format:
 *  - coin wallet:   "{chain}:{coin}"
 *  - token wallet:  "{chain}:{coin}:{tokenAddress}"
 */
export const getAssetIdFromWallet = (wallet: Wallet): string => {
  const chain = (wallet?.chain || '').toLowerCase();
  const coin = (wallet?.currencyAbbreviation || '').toLowerCase();

  if (!chain || !coin) {
    return '';
  }

  const tokenAddress = wallet?.tokenAddress;
  if (tokenAddress) {
    return `${chain}:${coin}:${tokenAddress.toLowerCase()}`;
  }

  return `${chain}:${coin}`;
};

export const parseAssetId = (assetId: string | undefined): ParsedAssetId => {
  const raw = (assetId || '').toLowerCase();
  const parts = raw.split(':');
  const chain = parts[0] || '';
  const coin = parts[1] || '';
  const tokenAddress = parts.length >= 3 ? parts[2] || undefined : undefined;
  return {
    assetId: raw,
    chain,
    coin,
    tokenAddress,
  };
};
