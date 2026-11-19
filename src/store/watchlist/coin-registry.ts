import {SupportedCurrencyOptions} from '../../constants/SupportedCurrencyOptions';
import {tokenManager, type TokenData} from '../../managers/TokenManager';
import {buildCoinCatalog} from './coins';

let source: TokenData = {tokenOptionsByAddress: {}, tokenDataByAddress: {}};
let catalog = buildCoinCatalog(SupportedCurrencyOptions, source);
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
const rebuild = (data: TokenData) => {
  if (
    data.tokenOptionsByAddress === source.tokenOptionsByAddress &&
    data.tokenDataByAddress === source.tokenDataByAddress
  ) {
    return;
  }
  source = data;
  catalog = buildCoinCatalog(SupportedCurrencyOptions, data);
  listeners.forEach(listener => listener());
};
export const getCoinCatalog = () => {
  rebuild(tokenManager.getTokenOptions());
  return catalog;
};
export const subscribeCoinCatalog = (listener: () => void) => {
  if (!unsubscribe) {
    unsubscribe = tokenManager.subscribe(rebuild);
  }
  listeners.add(listener);
  rebuild(tokenManager.getTokenOptions());
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
};
