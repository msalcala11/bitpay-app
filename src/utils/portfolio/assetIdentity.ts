type WalletLike = {
  chain?: string;
  currencyAbbreviation?: string;
  tokenAddress?: string;
};

type WalletCredentialsLike = {
  chain?: string;
  coin?: string;
  token?: {
    address?: string;
  };
  tokenAddress?: string;
};

const normalizeAssetIdentityPart = (value: unknown): string => {
  return String(value || '')
    .trim()
    .toLowerCase();
};

export const buildPortfolioAssetId = (args: {
  chain?: string;
  coin?: string;
  tokenAddress?: string;
}): string => {
  const chain = normalizeAssetIdentityPart(args.chain);
  const coin = normalizeAssetIdentityPart(args.coin);
  const tokenAddress = normalizeAssetIdentityPart(args.tokenAddress);

  return tokenAddress ? `${chain}:${coin}:${tokenAddress}` : `${chain}:${coin}`;
};

export const getPortfolioAssetIdFromWallet = (wallet?: WalletLike): string => {
  return buildPortfolioAssetId({
    chain: wallet?.chain,
    coin: wallet?.currencyAbbreviation,
    tokenAddress: wallet?.tokenAddress,
  });
};

export const getPortfolioAssetIdFromWalletCredentials = (
  credentials?: WalletCredentialsLike,
  fallbackCoin?: string,
): string => {
  return buildPortfolioAssetId({
    chain: credentials?.chain,
    coin: credentials?.coin || fallbackCoin,
    tokenAddress: credentials?.token?.address || credentials?.tokenAddress,
  });
};
