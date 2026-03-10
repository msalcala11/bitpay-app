import {getPersistEncryptionKey} from '..';
import {
  decryptGiftCardFields,
  hasEncryptedGiftCardFields,
  ShopGiftCardField,
  shopGiftCardFieldsToTransform,
} from '../transforms/encrypt';

export const giftCardNeedsDecryption = (
  giftCard: Partial<Record<ShopGiftCardField, unknown>>,
  fieldsToTransform: readonly ShopGiftCardField[] = shopGiftCardFieldsToTransform,
): boolean => hasEncryptedGiftCardFields(giftCard, fieldsToTransform);

export const decryptStoredGiftCardFields = async <T extends Record<string, any>>(
  giftCard: T,
  fieldsToTransform: readonly ShopGiftCardField[] = shopGiftCardFieldsToTransform,
): Promise<T> => {
  if (!giftCardNeedsDecryption(giftCard, fieldsToTransform)) {
    return giftCard;
  }

  const secretKey = await getPersistEncryptionKey();
  return decryptGiftCardFields(giftCard, secretKey, fieldsToTransform);
};
