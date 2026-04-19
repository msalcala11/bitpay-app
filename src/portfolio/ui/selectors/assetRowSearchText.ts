import {
  SupportedCurrencyOptions,
  type SupportedCurrencyOption,
} from '../../../constants/SupportedCurrencyOptions';
import {
  BitpaySupportedCoins,
  BitpaySupportedTokens,
} from '../../../constants/currencies';
import {getCurrencyAbbreviation} from '../../../utils/helper-methods';
import type {AssetRowItem} from '../../../utils/portfolio/assets';
import {createSupportedCurrencyOptionLookup} from '../../../utils/portfolio/supportedCurrencyOptionsLookup';

const supportedCurrencyOptionLookup = createSupportedCurrencyOptionLookup(
  SupportedCurrencyOptions,
);

const FALLBACK_SEPARATOR = '\u0000';

function getSupportedOptionForAssetRow(
  item: Pick<AssetRowItem, 'currencyAbbreviation' | 'chain' | 'tokenAddress'>,
): SupportedCurrencyOption | undefined {
  return supportedCurrencyOptionLookup.getOption({
    currencyAbbreviation: item.currencyAbbreviation,
    chain: item.chain,
    tokenAddress: item.tokenAddress,
  });
}

function normalizeSearchValue(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function buildAssetRowSearchText(
  item: Pick<
    AssetRowItem,
    'currencyAbbreviation' | 'chain' | 'tokenAddress' | 'name'
  >,
): string {
  const option = getSupportedOptionForAssetRow(item);
  const chainKey = String(option?.chain || item.chain || '').toLowerCase();
  const chainDisplayName = BitpaySupportedCoins[chainKey]?.name;

  const tokenDisplayName = option?.tokenAddress
    ? BitpaySupportedTokens[
        getCurrencyAbbreviation(option.tokenAddress, option.chain)
      ]?.name
    : undefined;

  return [
    option?.currencyName,
    option?.currencyAbbreviation,
    option?.chain,
    option?.chainName,
    item.name,
    item.currencyAbbreviation,
    item.chain,
    chainDisplayName,
    tokenDisplayName,
  ]
    .map(normalizeSearchValue)
    .filter((value): value is string => !!value)
    .join(FALLBACK_SEPARATOR);
}

export function getAssetRowSearchText(item: AssetRowItem): string {
  const normalized = normalizeSearchValue(item.searchText);
  if (normalized) {
    return normalized;
  }

  return buildAssetRowSearchText(item);
}

export default buildAssetRowSearchText;
