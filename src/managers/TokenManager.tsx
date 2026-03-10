import {Token} from '../store/wallet/wallet.models';
import {CurrencyOpts} from '../constants/currencies';
import {MMKV} from 'react-native-mmkv';
import {logManager} from './LogManager';
import {buildTokenManagerStateFromTokenOptions} from '../store/wallet/utils/token-options';

const TOKEN_OPTIONS_CACHE_KEY = 'token-options-cache-v1';
const TOKEN_OPTIONS_CACHE_VERSION = 1;
const tokenOptionsStorage = new MMKV();

type PersistedTokenOptionsCache = {
  version: number;
  updatedAt: number;
  tokenOptionsByAddress: {[key: string]: Token};
};

class TokenManager {
  private static instance: TokenManager;
  private listeners: Set<(data: TokenData) => void> = new Set();

  private tokenOptionsByAddress: {[key: string]: Token} = {};
  private tokenDataByAddress: {[key: string]: CurrencyOpts} = {};

  private constructor() {
    this.hydrateTokenOptionsFromCache();
  }

  static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  setTokenOptions(data: {
    tokenOptionsByAddress: {[key: string]: Token};
    tokenDataByAddress: {[key: string]: CurrencyOpts};
  }) {
    this.tokenOptionsByAddress = data.tokenOptionsByAddress;
    this.tokenDataByAddress = data.tokenDataByAddress;
    this.persistTokenOptionsToCache();
    this.notifyListeners();
  }

  getTokenOptions() {
    return {
      tokenOptionsByAddress: this.tokenOptionsByAddress,
      tokenDataByAddress: this.tokenDataByAddress,
    };
  }

  subscribe(listener: (data: TokenData) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners() {
    const data = this.getTokenOptions();
    this.listeners.forEach(listener => listener(data));
  }

  clear() {
    this.tokenOptionsByAddress = {};
    this.tokenDataByAddress = {};
    this.notifyListeners();
  }

  private hydrateTokenOptionsFromCache() {
    try {
      const cachedTokenOptions = tokenOptionsStorage.getString(
        TOKEN_OPTIONS_CACHE_KEY,
      );
      if (!cachedTokenOptions) {
        return;
      }

      const parsed = JSON.parse(
        cachedTokenOptions,
      ) as Partial<PersistedTokenOptionsCache>;

      if (parsed.version !== TOKEN_OPTIONS_CACHE_VERSION) {
        tokenOptionsStorage.delete(TOKEN_OPTIONS_CACHE_KEY);
        return;
      }

      const {tokenOptionsByAddress, tokenDataByAddress} =
        buildTokenManagerStateFromTokenOptions(parsed.tokenOptionsByAddress);

      if (!Object.keys(tokenOptionsByAddress).length) {
        tokenOptionsStorage.delete(TOKEN_OPTIONS_CACHE_KEY);
        return;
      }

      this.tokenOptionsByAddress = tokenOptionsByAddress;
      this.tokenDataByAddress = tokenDataByAddress;
      logManager.info(
        `[TokenManager] hydrated cached token options count:${Object.keys(
          tokenOptionsByAddress,
        ).length}`,
      );
    } catch (err) {
      tokenOptionsStorage.delete(TOKEN_OPTIONS_CACHE_KEY);
      const errorStr = err instanceof Error ? err.message : JSON.stringify(err);
      logManager.error(
        `[TokenManager] failed to hydrate cached token options: ${errorStr}`,
      );
    }
  }

  private persistTokenOptionsToCache() {
    try {
      const payload: PersistedTokenOptionsCache = {
        version: TOKEN_OPTIONS_CACHE_VERSION,
        updatedAt: Date.now(),
        tokenOptionsByAddress: this.tokenOptionsByAddress,
      };
      tokenOptionsStorage.set(TOKEN_OPTIONS_CACHE_KEY, JSON.stringify(payload));
    } catch (err) {
      const errorStr = err instanceof Error ? err.message : JSON.stringify(err);
      logManager.error(
        `[TokenManager] failed to persist token options cache: ${errorStr}`,
      );
    }
  }
}

export type TokenData = {
  tokenOptionsByAddress: {[key: string]: Token};
  tokenDataByAddress: {[key: string]: CurrencyOpts};
};

export const tokenManager = TokenManager.getInstance();
