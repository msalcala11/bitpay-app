import {createTransform} from 'redux-persist';
import {deserializePersistValue, encryptPersistValue} from './encrypt';

// Shared by ordinary persistence and migration; coverage and AAD are unchanged.
export const unencryptedPersistStores = new Set([
  'APP',
  'MARKET_STATS',
  'PORTFOLIO',
  'RATE',
  'SHOP',
  'SHOP_CATALOG',
  'WALLET',
]);

export const persistEncryptionTransform = (
  secretKey: string,
  onError: (error: unknown) => void = () => {},
) =>
  createTransform(
    (inboundState, key) =>
      typeof key === 'string' && unencryptedPersistStores.has(key)
        ? JSON.stringify(inboundState)
        : encryptPersistValue(
            inboundState,
            secretKey,
            `persist:${String(key)}`,
          ),
    (outboundState, key) => {
      try {
        return deserializePersistValue(
          outboundState,
          secretKey,
          String(key),
          typeof key === 'string' && unencryptedPersistStores.has(key),
        );
      } catch (error) {
        onError(error);
        throw error;
      }
    },
  );
