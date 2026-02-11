import type {SupportedCurrencyOption} from '../../constants/SupportedCurrencyOptions';

type OptionLookupArgs = {
  currencyAbbreviation?: string;
  chain?: string;
  tokenAddress?: string;
};

export type SupportedCurrencyOptionLookup = {
  getOption: (args: OptionLookupArgs) => SupportedCurrencyOption | undefined;
};

const normalize = (value: string | undefined): string =>
  (value || '').toLowerCase();

// Builds O(1) lookup tables for SupportedCurrencyOptions.
//
// This is intentionally behavior-compatible with the existing
// `findSupportedCurrencyOptionForAsset` fallback order:
// - Prefer strict chain+tokenAddress matches when tokenAddress is present
// - Fall back to tokenAddress-only matches
// - Fall back to a reasonable first option for the currency abbreviation
export const createSupportedCurrencyOptionLookup = (
  options: SupportedCurrencyOption[],
): SupportedCurrencyOptionLookup => {
  const byAbbr = new Map<string, SupportedCurrencyOption>();
  const byAbbrChain = new Map<string, SupportedCurrencyOption>();
  const byAbbrToken = new Map<string, SupportedCurrencyOption>();
  const byAbbrChainToken = new Map<string, SupportedCurrencyOption>();
  const tokenFallbackByAbbr = new Map<string, SupportedCurrencyOption>();

  for (const opt of options || []) {
    const abbr = normalize(opt?.currencyAbbreviation);
    if (!abbr) {
      continue;
    }
    const chain = normalize(opt?.chain);
    const tokenLower = opt?.tokenAddress ? normalize(opt.tokenAddress) : '';

    // First option wins so we preserve ordering-based behavior.
    if (!byAbbr.has(abbr)) {
      byAbbr.set(abbr, opt);
    }

    if (opt?.tokenAddress && !tokenFallbackByAbbr.has(abbr)) {
      tokenFallbackByAbbr.set(abbr, opt);
    }

    if (chain) {
      const chainKey = `${abbr}:${chain}`;
      if (!byAbbrChain.has(chainKey)) {
        byAbbrChain.set(chainKey, opt);
      }
    }

    if (tokenLower) {
      const tokenKey = `${abbr}:${tokenLower}`;
      if (!byAbbrToken.has(tokenKey)) {
        byAbbrToken.set(tokenKey, opt);
      }
      if (chain) {
        const exactKey = `${abbr}:${chain}:${tokenLower}`;
        if (!byAbbrChainToken.has(exactKey)) {
          byAbbrChainToken.set(exactKey, opt);
        }
      }
    }
  }

  const getOption = (
    args: OptionLookupArgs,
  ): SupportedCurrencyOption | undefined => {
    const abbr = normalize(args.currencyAbbreviation);
    if (!abbr) {
      return undefined;
    }

    const chain = normalize(args.chain);
    const tokenLower = args.tokenAddress ? normalize(args.tokenAddress) : '';
    const isWildcardChain = chain === abbr && !tokenLower;

    if (tokenLower) {
      const strict = chain
        ? byAbbrChainToken.get(`${abbr}:${chain}:${tokenLower}`)
        : undefined;
      if (strict) {
        return strict;
      }

      const byToken = byAbbrToken.get(`${abbr}:${tokenLower}`);
      if (byToken) {
        return byToken;
      }

      return tokenFallbackByAbbr.get(abbr) || byAbbr.get(abbr);
    }

    if (isWildcardChain) {
      return byAbbr.get(abbr);
    }

    if (chain) {
      const byChain = byAbbrChain.get(`${abbr}:${chain}`);
      if (byChain) {
        return byChain;
      }
    }

    return byAbbr.get(abbr);
  };

  return {getOption};
};
