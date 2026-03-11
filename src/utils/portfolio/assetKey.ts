import {normalizeFiatRateSeriesCoin} from './core/pnl/rates';

const normalizeAssetKeyPart = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

export const buildPortfolioAssetKey = (args: {
  currencyAbbreviation: string;
  chain?: string;
  tokenAddress?: string;
}): string => {
  const coin = normalizeFiatRateSeriesCoin(args.currencyAbbreviation || '');
  const chain = normalizeAssetKeyPart(args.chain || coin);
  const tokenAddress = normalizeAssetKeyPart(args.tokenAddress);

  if (!coin) {
    return '';
  }

  return [coin, chain].concat(tokenAddress ? [tokenAddress] : []).join('|');
};

export default buildPortfolioAssetKey;
